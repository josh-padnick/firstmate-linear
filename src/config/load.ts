import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { atomicWriteFile, ensurePrivateDir } from "../fsutil.ts";
import { resolveHome } from "../env.ts";
import {
  CONFIG_VERSION,
  ConfigError,
  DEFAULT_PROGRESS_DEADLINES,
  DEFAULT_PROMISE_VOCABULARY,
  FEATURE_MODES,
  STATUS_KEYS,
  type FeatureMode,
  type ManagedScope,
  type StatusKey,
  type TeamConfig,
  type WorkflowConfig,
} from "./schema.ts";

function duration(value: unknown, path: string, pointer: string, fallback: number): number {
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

const DEFAULT_STATUSES: Record<StatusKey, string> = {
  backlog: "Backlog",
  todo: "ToDo",
  prioritized: "Prioritized",
  waiting: "Waiting",
  plan_in_progress: "Plan In Progress",
  approve_plan: "Approve Plan",
  building: "Building",
  validating_code: "Validating Code",
  approve_deliverable: "Approve Deliverable",
  needs_decision: "Needs Decision",
  needs_firstmate_decision: "Needs Firstmate Decision",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
};

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

function mode(value: unknown, path: string, pointer: string, fallback: FeatureMode): FeatureMode {
  const resolved = value ?? fallback;
  if (typeof resolved !== "string" || !(FEATURE_MODES as readonly string[]).includes(resolved)) {
    throw new ConfigError(path, pointer, `expected one of ${FEATURE_MODES.join(", ")}`);
  }
  return resolved as FeatureMode;
}

function strings(value: unknown, path: string, pointer: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ConfigError(path, pointer, "expected a list of non-empty strings");
  }
  return value.map((item) => (item as string).trim());
}

function parseTeam(value: unknown, path: string, index: number): TeamConfig {
  const pointer = `.teams[${index}]`;
  const row = record(value, path, pointer);
  const scope = row.managed ?? "assignee:self";
  if (scope !== "assignee:self" && scope !== "all") {
    throw new ConfigError(path, `${pointer}.managed`, "expected assignee:self or all");
  }
  const statusesRaw = record(row.statuses ?? {}, path, `${pointer}.statuses`);
  const statuses = { ...DEFAULT_STATUSES };
  for (const key of STATUS_KEYS) {
    if (statusesRaw[key] != null) statuses[key] = string(statusesRaw[key], path, `${pointer}.statuses.${key}`);
  }
  const labelsRaw = record(row.agent_labels ?? {}, path, `${pointer}.agent_labels`);
  const agent_labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(labelsRaw)) {
    agent_labels[key] = string(label, path, `${pointer}.agent_labels.${key}`);
  }
  return {
    key: string(row.key, path, `${pointer}.key`).toUpperCase(),
    projects: strings(row.projects, path, `${pointer}.projects`),
    managed: scope as ManagedScope,
    statuses,
    agent_labels,
  };
}

function templatePath(value: unknown, fallback: string, path: string, pointer: string): string {
  const configured = value == null ? fallback : string(value, path, pointer);
  return normalize(isAbsolute(configured) ? configured : join(dirname(path), configured));
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
  const deadlines = record(root.deadlines ?? {}, path, ".deadlines");
  const progress = record(deadlines.progress ?? {}, path, ".deadlines.progress");
  const stalled = record(deadlines.stalled ?? {}, path, ".deadlines.stalled");
  const promises = record(root.promises ?? {}, path, ".promises");
  return {
    version: CONFIG_VERSION,
    captain: { display_name: string(captain.display_name, path, ".captain.display_name") },
    teams,
    features: {
      relay: mode(features.relay, path, ".features.relay", "shadow"),
      mirror: mode(features.mirror, path, ".features.mirror", "shadow"),
      escalation: mode(features.escalation, path, ".features.escalation", "shadow"),
    },
    templates: {
      reply: templatePath(templates.reply, "reply.md", path, ".templates.reply"),
      report: templatePath(templates.report, "report.md", path, ".templates.report"),
      review_walkthrough: templatePath(templates.review_walkthrough, "review-walkthrough.html", path, ".templates.review_walkthrough"),
    },
    deadlines: {
      progress: Object.fromEntries(Object.entries(DEFAULT_PROGRESS_DEADLINES).map(([status, fallback]) => [
        status,
        duration(progress[status], path, `.deadlines.progress.${status}`, fallback),
      ])),
      stalled: { mention: duration(stalled.mention, path, ".deadlines.stalled.mention", 30 * 60) },
    },
    promises: {
      required_on_firstmate_owned: promises.required_on_firstmate_owned == null
        ? true
        : promises.required_on_firstmate_owned === true
          ? true
          : promises.required_on_firstmate_owned === false
            ? false
            : (() => { throw new ConfigError(path, ".promises.required_on_firstmate_owned", "expected true or false"); })(),
      vocabulary: promises.vocabulary == null
        ? [...DEFAULT_PROMISE_VOCABULARY]
        : strings(promises.vocabulary, path, ".promises.vocabulary"),
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
    const lastGood = `${path}.last-good`;
    atomicWriteFile(lastGood, readFileSync(path, "utf8"));
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
