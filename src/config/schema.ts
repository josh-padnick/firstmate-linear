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
  sourcePath: string;
};

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
