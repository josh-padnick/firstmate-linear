export const CONFIG_VERSION = 1;

export const FEATURE_MODES = ["off", "shadow", "on"] as const;
export type FeatureMode = (typeof FEATURE_MODES)[number];

export const STATUS_KEYS = [
  "backlog",
  "todo",
  "prioritized",
  "waiting",
  "plan_in_progress",
  "approve_plan",
  "building",
  "validating_code",
  "approve_deliverable",
  "needs_decision",
  "needs_firstmate_decision",
  "done",
  "canceled",
  "duplicate",
] as const;

export type StatusKey = (typeof STATUS_KEYS)[number];

export type ManagedScope = "assignee:self" | "all";

export type TeamConfig = {
  key: string;
  projects: string[];
  managed: ManagedScope;
  statuses: Record<StatusKey, string>;
  agent_labels: Record<string, string>;
};

export type WorkflowConfig = {
  version: 1;
  captain: {
    display_name: string;
  };
  teams: TeamConfig[];
  features: {
    relay: FeatureMode;
    mirror: FeatureMode;
    escalation: FeatureMode;
  };
  templates: {
    reply: string;
    report: string;
    review_walkthrough: string;
  };
  deadlines?: {
    progress: Record<string, number>;
    stalled: { mention: number };
  };
  promises?: {
    required_on_firstmate_owned: boolean;
    vocabulary: string[];
  };
  sourcePath: string;
};

export const DEFAULT_PROGRESS_DEADLINES: Record<string, number> = {
  "Plan In Progress": 30 * 60,
  Building: 45 * 60,
  "Validating Code": 60 * 60,
  Waiting: 4 * 60 * 60,
  "Needs Firstmate Decision": 15 * 60,
};

export const DEFAULT_PROMISE_VOCABULARY = [
  "status:*", "board:*", "pr-reported", "pr-green", "pr-merged", "comment", "dispatch", "none",
] as const;

export class ConfigError extends Error {
  constructor(
    readonly path: string,
    readonly pointer: string,
    message: string,
  ) {
    super(`${path}${pointer}: ${message}`);
    this.name = "ConfigError";
  }
}
