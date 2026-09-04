import type { TeamConfig, WorkflowConfig } from "../config/schema.ts";
import type { EventDisposition, IssueSnapshot, NewJob } from "../db/database.ts";

export const TOKENS = [
  "start-now",
  "plan-approved",
  "ball-returned",
  "approval",
  "terminal",
  "scope-changed",
  "comment",
  "resumed",
  "stalled",
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
  from_state?: string | null;
  to_state?: string | null;
  from_assignee?: string | null;
  to_assignee?: string | null;
  created_at: string;
};

export type Classification = {
  token: EventToken;
  disposition: EventDisposition;
  jobs: NewJob[];
  note: string | null;
};

export function normalizedComment(body: string): string {
  return body
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/[`*_~>#\[\]()!-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

export function isExactApproval(body: string): boolean {
  const normalized = normalizedComment(body);
  return normalized === "approved" || normalized === "lgtm";
}

function teamFor(config: WorkflowConfig, key: string): TeamConfig | null {
  return config.teams.find((team) => team.key === key) ?? null;
}

function gate(team: TeamConfig, state: string | null | undefined): "plan" | "deliverable" | "decision" | null {
  if (state === team.statuses.approve_plan) return "plan";
  if (state === team.statuses.approve_deliverable) return "deliverable";
  if (state === team.statuses.needs_decision) return "decision";
  return null;
}

function gateJob(event: ClassifiableEvent, target: string, expectedState: string, reason: string): NewJob {
  return {
    key: `${event.id}:gate:${target}`,
    kind: "linear.issue-state",
    target: event.issue,
    payload: {
      issue: event.issue,
      state: target,
      expected_state: expectedState,
      cause_event: event.id,
      comment: reason,
      actor: "service",
      requires_managed: true,
    },
  };
}

export function classifyEvent(
  event: ClassifiableEvent,
  config: WorkflowConfig,
  snapshot: IssueSnapshot | null,
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
    const terminal = [team.statuses.done, team.statuses.canceled, team.statuses.duplicate];
    if (event.to_state && terminal.includes(event.to_state)) {
      return { token: "terminal", disposition: "waiting-for-core", jobs: [], note: null };
    }
    if (event.to_state === team.statuses.prioritized) {
      return { token: "start-now", disposition: "waiting-for-core", jobs: [], note: null };
    }
    if (event.from_assignee !== event.to_assignee) {
      return { token: "scope-changed", disposition: "waiting-for-core", jobs: [], note: null };
    }
    return { token: "noise", disposition: "ignored", jobs: [], note: "non-actionable board change" };
  }
  if (event.type !== "comment") {
    return { token: "noise", disposition: "ignored", jobs: [], note: "non-comment event" };
  }

  const currentGate = gate(team, snapshot?.state);
  const body = event.body ?? "";
  if ((currentGate === "plan" || currentGate === "deliverable") && isExactApproval(body)) {
    const target = currentGate === "plan" ? team.statuses.building : team.statuses.validating_code;
    const token: EventToken = currentGate === "plan" ? "plan-approved" : "approval";
    return {
      token,
      disposition: "waiting-for-core",
      jobs: [gateJob(event, target, snapshot!.state, `Captain ${token.replace("-", " ")} recorded.`)],
      note: null,
    };
  }
  if (currentGate) {
    return {
      token: "ball-returned",
      disposition: "waiting-for-core",
      jobs: [gateJob(event, team.statuses.building, snapshot!.state, "Captain feedback received; returning ownership to Firstmate.")],
      note: null,
    };
  }
  return { token: "comment", disposition: "waiting-for-core", jobs: [], note: null };
}
