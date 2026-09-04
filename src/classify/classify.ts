import type { GateRole, TeamConfig, WorkflowConfig, WorkflowRole } from "../config/schema.ts";
import type { EventDisposition, NewIssueSnapshot, NewJob } from "../db/database.ts";
import { resolvePreferredRole } from "../workflow/roles.ts";

export const TOKENS = [
  "start-now",
  "gate-pass",
  "ball-returned",
  "terminal",
  "scope-changed",
  "comment",
  "resumed",
  "stalled",
  "verdict",
  "noise",
] as const;

export type EventToken = (typeof TOKENS)[number];

export type ClassifiableEvent = {
  id: string;
  team: string;
  issue: string;
  type: string;
  author: string;
  body?: string | null;
  parent_id?: string | null;
  from_state?: WorkflowRole | null;
  to_state?: WorkflowRole | null;
  from_assignee?: string | null;
  to_assignee?: string | null;
  created_at: string;
};

export type Classification = {
  token: EventToken;
  disposition: EventDisposition;
  jobs: NewJob[];
  note: string | null;
  gate?: GateRole;
  next?: WorkflowRole | "merge" | "stay";
};

export function normalizedComment(body: string): string {
  let normalized = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let prior = "";
  while (normalized !== prior) {
    prior = normalized;
    normalized = normalized
      .replace(/^[\s`*_~>#]+|[\s`*_~>#]+$/g, "")
      .replace(/[.!?,;:]+$/g, "")
      .trim();
  }
  return normalized.toLocaleLowerCase("en-US");
}

export function isExactGatePhrase(body: string, phrases: readonly string[]): boolean {
  const normalized = normalizedComment(body);
  return phrases.some((phrase) => normalizedComment(phrase) === normalized);
}

export function isPotentialGatePhrase(body: string, config: WorkflowConfig): boolean {
  return Object.values(config.gates).some((gate) => isExactGatePhrase(body, gate.phrases));
}

function teamFor(config: WorkflowConfig, key: string): TeamConfig | null {
  return config.teams.find((team) => team.key === key) ?? null;
}

function gate(team: TeamConfig, role: string | null | undefined): GateRole | null {
  if (role === "plan-gate" && team.roles[role]) return role;
  if (role === "review-gate" && team.roles[role]) return role;
  if (role === "merge-gate" && team.roles[role]) return role;
  return null;
}

function roleJob(event: ClassifiableEvent, target: WorkflowRole, expectedRole: WorkflowRole, reason: string): NewJob {
  return {
    key: `${event.id}:gate:${target}`,
    kind: "linear.issue-role",
    target: event.issue,
    payload: {
      issue: event.issue,
      role: target,
      expected_role: expectedRole,
      cause_event: event.id,
      comment: reason,
      actor: "service",
      requires_managed: true,
    },
  };
}

function acknowledgementJob(event: ClassifiableEvent, gateRole: GateRole, next: string): NewJob {
  return {
    key: `${event.id}:gate-ack`,
    kind: "linear.comment",
    target: event.issue,
    payload: {
      issue: event.issue,
      body: `Approved at ${gateRole} -> ${next}.`,
      actor: "service",
      requires_managed: true,
    },
  };
}

function mergePromiseJob(event: ClassifiableEvent, gateRole: GateRole): NewJob {
  return {
    key: `${event.id}:promise:pr-merged`,
    kind: "promise.implicit",
    target: event.issue,
    payload: {
      issue: event.issue,
      source_event_id: event.id,
      expected_event: "pr-merged",
      deadline: "merge",
      gate: gateRole,
    },
  };
}

function mergeAuthorization(event: ClassifiableEvent, gateRole: GateRole): Classification {
  return {
    token: "gate-pass",
    disposition: "waiting-for-core",
    jobs: [acknowledgementJob(event, gateRole, "merge authorized"), mergePromiseJob(event, gateRole)],
    note: "required: merge the linked PR (or relay the word to the lane that holds it)",
    gate: gateRole,
    next: "merge",
  };
}

export function classifyEvent(
  event: ClassifiableEvent,
  config: WorkflowConfig,
  snapshot: NewIssueSnapshot | null,
): Classification {
  const team = teamFor(config, event.team);
  if (!team) return { token: "noise", disposition: "ignored", jobs: [], note: "unmanaged team" };
  if (event.author !== config.captain.display_name && event.type !== "resumed") {
    return { token: "noise", disposition: "ignored", jobs: [], note: "not captain-authored" };
  }
  if (event.type === "resumed") {
    return { token: "resumed", disposition: "waiting-for-core", jobs: [], note: null };
  }
  if (event.type === "issue-created") {
    return { token: "start-now", disposition: "waiting-for-core", jobs: [], note: null };
  }
  if (event.type === "board") {
    if (event.to_state === "done" || event.to_state === "canceled") {
      return { token: "terminal", disposition: "waiting-for-core", jobs: [], note: null };
    }
    if (event.from_assignee !== event.to_assignee) {
      return { token: "scope-changed", disposition: "waiting-for-core", jobs: [], note: null };
    }
    return { token: "noise", disposition: "ignored", jobs: [], note: "non-actionable board change" };
  }
  if (event.type !== "comment") {
    return { token: "noise", disposition: "ignored", jobs: [], note: "non-comment event" };
  }

  const currentGate = gate(team, snapshot?.role);
  const body = event.body ?? "";
  if (currentGate === "merge-gate" && ["approved", "lgtm"].includes(normalizedComment(body))) {
    return {
      token: "comment",
      disposition: "waiting-for-core",
      jobs: [],
      note: "required: ask whether the captain intended merge authorization",
    };
  }
  if (currentGate && isExactGatePhrase(body, config.gates[currentGate].phrases)) {
    if (currentGate === "merge-gate") return mergeAuthorization(event, currentGate);
    const configuredNext = config.gates[currentGate].next;
    const fallbacks: WorkflowRole[] = currentGate === "review-gate" ? ["merge-gate"] : ["building"];
    const resolution = resolvePreferredRole(team, configuredNext, fallbacks);
    if (resolution.kind === "stay" || (currentGate === "review-gate" && resolution.role === "done")) {
      return mergeAuthorization(event, currentGate);
    }
    return {
      token: "gate-pass",
      disposition: "waiting-for-core",
      jobs: [roleJob(event, resolution.role, currentGate, `Approved at ${currentGate} -> ${resolution.role}.`)],
      note: null,
      gate: currentGate,
      next: resolution.role,
    };
  }
  if (currentGate) {
    return {
      token: "ball-returned",
      disposition: "waiting-for-core",
      jobs: [roleJob(event, "building", currentGate, "Captain feedback received; returning ownership to Firstmate.")],
      note: null,
    };
  }
  return { token: "comment", disposition: "waiting-for-core", jobs: [], note: null };
}
