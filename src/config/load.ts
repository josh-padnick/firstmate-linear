import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { atomicWriteFile, ensurePrivateDir } from "../fsutil.ts";
import { resolveHome } from "../env.ts";
import {
  CONFIG_VERSION,
  ConfigError,
  DEFAULT_GATES,
  DEFAULT_PROGRESS_DEADLINES,
  DEFAULT_PROMISE_VOCABULARY,
  FEATURE_MODES,
  GATE_ROLES,
  REQUIRED_WORKFLOW_ROLES,
  WORKFLOW_ROLES,
  type FeatureMode,
  type GateRole,
  type ManagedScope,
  type TeamConfig,
  type ValidationMode,
  type ValidationSource,
  type WorkflowConfig,
  type WorkflowRole,
} from "./schema.ts";

export function parseDuration(value: unknown, path: string, pointer: string, fallback: number): number {
  if (value == null) return fallback;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value !== "string") throw new ConfigError(path, pointer, "expected a duration such as 30m or 2h");
  const match = /^(\d+)(s|m|h|d)$/.exec(value.trim());
  if (!match) throw new ConfigError(path, pointer, "expected a duration such as 30m or 2h");
  const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = Number(match[1]) * units[match[2]!]!;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new ConfigError(path, pointer, "duration must be positive");
  return seconds;
}

function record(value: unknown, path: string, pointer: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(path, pointer, "expected a mapping");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string, pointer: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigError(path, pointer, "expected a non-empty string");
  }
  return value.trim();
}

function positiveNumber(value: unknown, path: string, pointer: string, fallback: number): number {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(path, pointer, "expected a positive number");
  }
  return value;
}

function positiveInteger(value: unknown, path: string, pointer: string, fallback: number): number {
  const number = positiveNumber(value, path, pointer, fallback);
  if (!Number.isSafeInteger(number)) throw new ConfigError(path, pointer, "expected a positive integer");
  return number;
}

function mode(value: unknown, path: string, pointer: string, fallback: FeatureMode): FeatureMode {
  const resolved = value ?? fallback;
  if (typeof resolved !== "string" || !(FEATURE_MODES as readonly string[]).includes(resolved)) {
    throw new ConfigError(path, pointer, `expected one of ${FEATURE_MODES.join(", ")}`);
  }
  return resolved as FeatureMode;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string, pointer: string, fallback: T): T {
  const resolved = value ?? fallback;
  if (typeof resolved !== "string" || !allowed.includes(resolved as T)) {
    throw new ConfigError(path, pointer, `expected one of ${allowed.join(", ")}`);
  }
  return resolved as T;
}

function strings(value: unknown, path: string, pointer: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ConfigError(path, pointer, "expected a list of non-empty strings");
  }
  return value.map((item) => (item as string).trim());
}

function boolean(value: unknown, path: string, pointer: string, fallback: boolean): boolean {
  if (value == null) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(path, pointer, "expected true or false");
  return value;
}

function parseTeam(value: unknown, path: string, index: number): TeamConfig {
  const pointer = `.teams[${index}]`;
  const row = record(value, path, pointer);
  const scope = row.managed ?? "assignee:self";
  if (scope !== "assignee:self" && scope !== "all") {
    throw new ConfigError(path, `${pointer}.managed`, "expected assignee:self or all");
  }
  if (row.statuses != null) {
    throw new ConfigError(path, `${pointer}.statuses`, "statuses were replaced by role mappings; use roles");
  }
  const rolesRaw = record(row.roles ?? {}, path, `${pointer}.roles`);
  const roles: Partial<Record<WorkflowRole, string>> = {};
  for (const [role, name] of Object.entries(rolesRaw)) {
    if (!(WORKFLOW_ROLES as readonly string[]).includes(role)) {
      throw new ConfigError(path, `${pointer}.roles.${role}`, `unknown workflow role; expected one of ${WORKFLOW_ROLES.join(", ")}`);
    }
    roles[role as WorkflowRole] = string(name, path, `${pointer}.roles.${role}`);
  }
  for (const role of REQUIRED_WORKFLOW_ROLES) {
    if (!roles[role]) throw new ConfigError(path, `${pointer}.roles.${role}`, "required workflow role is unmapped");
  }
  const duplicate = Object.entries(roles).find(([role, name], index, entries) => entries.some(([otherRole, otherName], otherIndex) => otherIndex < index && otherRole !== role && otherName === name));
  if (duplicate) throw new ConfigError(path, `${pointer}.roles.${duplicate[0]}`, `status ${JSON.stringify(duplicate[1])} is already mapped to another role`);
  const labelsRaw = record(row.agent_labels ?? {}, path, `${pointer}.agent_labels`);
  const agent_labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(labelsRaw)) {
    agent_labels[key] = string(label, path, `${pointer}.agent_labels.${key}`);
  }
  return {
    key: string(row.key, path, `${pointer}.key`).toUpperCase(),
    projects: strings(row.projects, path, `${pointer}.projects`),
    managed: scope as ManagedScope,
    roles,
    agent_labels,
  };
}

function templatePath(value: unknown, fallback: string, path: string, pointer: string): string {
  const configured = value == null ? fallback : string(value, path, pointer);
  return normalize(isAbsolute(configured) ? configured : join(dirname(path), configured));
}

export function roleForState(team: TeamConfig, state: string | null | undefined): WorkflowRole | null {
  if (!state) return null;
  return (Object.entries(team.roles) as Array<[WorkflowRole, string]>).find(([, name]) => name === state)?.[0] ?? null;
}

export function stateNameForRole(team: TeamConfig, role: WorkflowRole): string | null {
  return team.roles[role] ?? null;
}

export function parseConfig(raw: unknown, path: string): WorkflowConfig {
  const root = record(raw, path, "");
  if (root.version !== CONFIG_VERSION) {
    throw new ConfigError(path, ".version", `expected ${CONFIG_VERSION}, got ${JSON.stringify(root.version)}`);
  }
  const captain = record(root.captain, path, ".captain");
  if (!Array.isArray(root.teams) || root.teams.length === 0) {
    throw new ConfigError(path, ".teams", "expected at least one team");
  }
  const teams = root.teams.map((item, index) => parseTeam(item, path, index));
  const unique = new Set(teams.map((team) => team.key));
  if (unique.size !== teams.length) throw new ConfigError(path, ".teams", "team keys must be unique");
  const features = record(root.features ?? {}, path, ".features");
  const templates = record(root.templates ?? {}, path, ".templates");
  const gatesRaw = record(root.gates ?? {}, path, ".gates");
  const gates = {} as Record<GateRole, { phrases: string[]; next: WorkflowRole }>;
  for (const role of GATE_ROLES) {
    const configured = gatesRaw[role] == null ? {} : record(gatesRaw[role], path, `.gates.${role}`);
    const next = enumValue(configured.next, WORKFLOW_ROLES, path, `.gates.${role}.next`, DEFAULT_GATES[role].next);
    gates[role] = {
      phrases: configured.phrases == null ? [...DEFAULT_GATES[role].phrases] : strings(configured.phrases, path, `.gates.${role}.phrases`),
      next,
    };
  }
  for (const key of Object.keys(gatesRaw)) {
    if (!(GATE_ROLES as readonly string[]).includes(key)) throw new ConfigError(path, `.gates.${key}`, "only gate roles may define gate phrases");
  }
  const deadlinesRaw = record(root.deadlines ?? {}, path, ".deadlines");
  const progressRaw = record(deadlinesRaw.progress ?? {}, path, ".deadlines.progress");
  const progress = { ...DEFAULT_PROGRESS_DEADLINES };
  for (const [role, value] of Object.entries(progressRaw)) {
    if (!(WORKFLOW_ROLES as readonly string[]).includes(role)) throw new ConfigError(path, `.deadlines.progress.${role}`, "progress deadlines are keyed by role");
    progress[role as WorkflowRole] = parseDuration(value, path, `.deadlines.progress.${role}`, 1);
  }
  const stalled = record(deadlinesRaw.stalled ?? {}, path, ".deadlines.stalled");
  const idle = record(deadlinesRaw.idle ?? {}, path, ".deadlines.idle");
  const steer = record(deadlinesRaw.steer ?? {}, path, ".deadlines.steer");
  const promiseDeadlines = record(deadlinesRaw.promises ?? {}, path, ".deadlines.promises");
  const promises = record(root.promises ?? {}, path, ".promises");
  const validation = record(root.validation ?? {}, path, ".validation");
  const merge = record(root.merge ?? {}, path, ".merge");
  const messages = record(root.messages ?? {}, path, ".messages");
  const evidence = record(root.evidence ?? {}, path, ".evidence");
  const hosts = record(root.hosts ?? {}, path, ".hosts");
  const service = record(root.service ?? {}, path, ".service");
  const validationMode = enumValue(validation.mode, ["word", "verdict"] as const, path, ".validation.mode", "word") as ValidationMode;
  const validationSource = enumValue(validation.source, ["check", "labels", "review"] as const, path, ".validation.source", "check") as ValidationSource;
  const probeUrl = string(service.probe_url ?? "https://api.github.com", path, ".service.probe_url");
  try { new URL(probeUrl); } catch { throw new ConfigError(path, ".service.probe_url", "expected an absolute URL"); }
  return {
    version: CONFIG_VERSION,
    captain: { display_name: string(captain.display_name, path, ".captain.display_name") },
    teams,
    features: {
      relay: mode(features.relay, path, ".features.relay", "shadow"),
      mirror: mode(features.mirror, path, ".features.mirror", "shadow"),
      escalation: mode(features.escalation, path, ".features.escalation", "shadow"),
    },
    gates,
    validation: {
      mode: validationMode,
      source: validationSource,
      check_name: string(validation.check_name ?? "fleet-validation", path, ".validation.check_name"),
      gate_check_name: string(validation.gate_check_name ?? "fleet-merge-gate", path, ".validation.gate_check_name"),
    },
    merge: {
      never_auto_paths: strings(merge.never_auto_paths, path, ".merge.never_auto_paths"),
      max_auto_lines: positiveInteger(merge.max_auto_lines, path, ".merge.max_auto_lines", 10_000),
    },
    templates: {
      reply: templatePath(templates.reply, "reply.md", path, ".templates.reply"),
      report: templatePath(templates.report, "report.md", path, ".templates.report"),
      review_walkthrough: templatePath(templates.review_walkthrough, "review-walkthrough.html", path, ".templates.review_walkthrough"),
    },
    deadlines: {
      progress,
      stalled: { mention: parseDuration(stalled.mention, path, ".deadlines.stalled.mention", 30 * 60) },
      idle: {
        silent: parseDuration(idle.silent, path, ".deadlines.idle.silent", 5 * 60),
        after_nudge: parseDuration(idle.after_nudge, path, ".deadlines.idle.after_nudge", 5 * 60),
        unknown_grace: parseDuration(idle.unknown_grace, path, ".deadlines.idle.unknown_grace", 10 * 60),
      },
      steer: {
        redeliver: parseDuration(steer.redeliver, path, ".deadlines.steer.redeliver", 3 * 60),
        stalled: parseDuration(steer.stalled, path, ".deadlines.steer.stalled", 10 * 60),
        remote_check: parseDuration(steer.remote_check, path, ".deadlines.steer.remote_check", 60),
      },
      promises: {
        validating: parseDuration(promiseDeadlines.validating, path, ".deadlines.promises.validating", 60 * 60),
        merge: parseDuration(promiseDeadlines.merge, path, ".deadlines.promises.merge", 10 * 60),
      },
    },
    promises: {
      required_on_firstmate_owned: boolean(promises.required_on_firstmate_owned, path, ".promises.required_on_firstmate_owned", true),
      vocabulary: promises.vocabulary == null ? [...DEFAULT_PROMISE_VOCABULARY] : strings(promises.vocabulary, path, ".promises.vocabulary"),
    },
    messages: {
      idle_nudge: string(messages.idle_nudge ?? "You stopped without reporting. Append `done:`, `blocked:`, or `needs-decision:` to your status file, or continue the task.", path, ".messages.idle_nudge"),
      status_queries: messages.status_queries == null ? ["status", "status?", "current status", "update?"] : strings(messages.status_queries, path, ".messages.status_queries"),
    },
    evidence: {
      transcript_tail: positiveInteger(evidence.transcript_tail, path, ".evidence.transcript_tail", 8),
    },
    hosts: {
      check_interval: parseDuration(hosts.check_interval, path, ".hosts.check_interval", 60),
      window: parseDuration(hosts.window, path, ".hosts.window", 5 * 60),
      load_factor: positiveNumber(hosts.load_factor, path, ".hosts.load_factor", 4),
      min_free_mb: positiveNumber(hosts.min_free_mb, path, ".hosts.min_free_mb", 512),
    },
    service: {
      poll_failures_before_restart: positiveInteger(service.poll_failures_before_restart, path, ".service.poll_failures_before_restart", 6),
      probe_url: probeUrl,
    },
    sourcePath: path,
  };
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.FM_LINEAR_CONFIG?.trim() || join(resolveHome(env), "config", "linear-workflow.yaml");
}

export function loadConfigFile(path: string): WorkflowConfig {
  try {
    return parseConfig(Bun.YAML.parse(readFileSync(path, "utf8")), path);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(path, "", `cannot load YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkflowConfig {
  const path = configPath(env);
  try {
    const config = loadConfigFile(path);
    atomicWriteFile(`${path}.last-good`, readFileSync(path, "utf8"));
    return config;
  } catch (error) {
    const lastGood = `${path}.last-good`;
    if (existsSync(lastGood)) return loadConfigFile(lastGood);
    throw error;
  }
}

export function installDefaultConfig(source: string, env: NodeJS.ProcessEnv = process.env): string {
  const destination = configPath(env);
  ensurePrivateDir(dirname(destination));
  if (!existsSync(destination)) copyFileSync(source, destination);
  loadConfigFile(destination);
  return destination;
}

export function effectiveConfig(config: WorkflowConfig): Omit<WorkflowConfig, "sourcePath"> {
  const { sourcePath: _, ...value } = config;
  return value;
}
