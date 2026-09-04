export const CONFIG_VERSION = 1;

export const FEATURE_MODES = ["off", "shadow", "on"] as const;
export type FeatureMode = (typeof FEATURE_MODES)[number];

export const WORKFLOW_ROLES = [
  "plan",
  "plan-gate",
  "waiting",
  "building",
  "review-gate",
  "validating",
  "merge-gate",
  "decision-captain",
  "decision-firstmate",
  "done",
  "canceled",
] as const;

export type WorkflowRole = (typeof WORKFLOW_ROLES)[number];

export const REQUIRED_WORKFLOW_ROLES = ["building", "done", "canceled"] as const satisfies readonly WorkflowRole[];
export const GATE_ROLES = ["plan-gate", "review-gate", "merge-gate"] as const satisfies readonly WorkflowRole[];
export type GateRole = (typeof GATE_ROLES)[number];

export const FIRSTMATE_OWNED_ROLES = ["plan", "waiting", "building", "validating", "decision-firstmate"] as const satisfies readonly WorkflowRole[];
export const CAPTAIN_OWNED_ROLES = ["plan-gate", "review-gate", "merge-gate", "decision-captain"] as const satisfies readonly WorkflowRole[];

export type ManagedScope = "assignee:self" | "all";

export type TeamConfig = {
  key: string;
  projects: string[];
  managed: ManagedScope;
  roles: Partial<Record<WorkflowRole, string>>;
  agent_labels: Record<string, string>;
};

export type GateConfig = {
  phrases: string[];
  next: WorkflowRole;
};

export type ValidationMode = "word" | "verdict";
export type ValidationSource = "check" | "labels" | "review";

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
  gates: Record<GateRole, GateConfig>;
  validation: {
    mode: ValidationMode;
    source: ValidationSource;
    check_name: string;
    gate_check_name: string;
  };
  merge: {
    never_auto_paths: string[];
    max_auto_lines: number;
  };
  templates: {
    reply: string;
    report: string;
    review_walkthrough: string;
  };
  deadlines: {
    progress: Partial<Record<WorkflowRole, number>>;
    stalled: { mention: number };
    idle: { silent: number; after_nudge: number; unknown_grace: number };
    steer: { redeliver: number; stalled: number; remote_check: number };
    promises: { validating: number; merge: number };
  };
  promises: {
    required_on_firstmate_owned: boolean;
    vocabulary: string[];
  };
  messages: {
    idle_nudge: string;
    status_queries: string[];
  };
  evidence: {
    transcript_tail: number;
  };
  hosts: {
    check_interval: number;
    window: number;
    load_factor: number;
    min_free_mb: number;
  };
  service: {
    poll_failures_before_restart: number;
    probe_url: string;
  };
  sourcePath: string;
};

export const DEFAULT_PROGRESS_DEADLINES: Partial<Record<WorkflowRole, number>> = {
  plan: 30 * 60,
  building: 45 * 60,
  validating: 60 * 60,
  waiting: 4 * 60 * 60,
  "decision-firstmate": 15 * 60,
};

export const DEFAULT_PROMISE_VOCABULARY = [
  "status:*", "board:*", "pr-reported", "pr-green", "pr-merged", "verdict", "comment", "dispatch", "none",
] as const;

export const DEFAULT_GATES: Record<GateRole, GateConfig> = {
  "plan-gate": {
    phrases: ["approved", "lgtm", "let's merge it", "merge it", "ship it", "go"],
    next: "building",
  },
  "review-gate": {
    phrases: ["approved", "lgtm", "let's merge it", "merge it", "ship it"],
    next: "validating",
  },
  "merge-gate": {
    phrases: ["merge", "let's merge it", "merge it", "ship it"],
    next: "done",
  },
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
