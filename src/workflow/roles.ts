import { CAPTAIN_OWNED_ROLES, FIRSTMATE_OWNED_ROLES, type TeamConfig, type WorkflowRole } from "../config/schema.ts";

export type WorkflowSignal =
  | "needs-decision"
  | "pr-green"
  | "dispatch-scout"
  | "dispatch"
  | "lane-cap"
  | "blocked"
  | "failed"
  | "pr-merged";

const FALLBACKS: Record<WorkflowSignal, readonly WorkflowRole[]> = {
  "needs-decision": ["decision-captain"],
  "pr-green": ["review-gate", "merge-gate", "validating"],
  "dispatch-scout": ["plan", "building"],
  dispatch: ["building"],
  "lane-cap": ["waiting"],
  blocked: ["decision-firstmate"],
  failed: ["decision-firstmate"],
  "pr-merged": ["done"],
};

export type RoleResolution = { kind: "move"; role: WorkflowRole } | { kind: "stay"; comment: true };

export function resolveSignalRole(team: TeamConfig, signal: WorkflowSignal): RoleResolution {
  const role = FALLBACKS[signal].find((candidate) => Boolean(team.roles[candidate]));
  return role ? { kind: "move", role } : { kind: "stay", comment: true };
}

export function resolvePreferredRole(team: TeamConfig, preferred: WorkflowRole, fallbacks: readonly WorkflowRole[] = []): RoleResolution {
  const role = [preferred, ...fallbacks].find((candidate) => Boolean(team.roles[candidate]));
  return role ? { kind: "move", role } : { kind: "stay", comment: true };
}

export function isFirstmateOwnedRole(role: string | null | undefined): role is WorkflowRole {
  return Boolean(role && (FIRSTMATE_OWNED_ROLES as readonly string[]).includes(role));
}

export function isCaptainOwnedRole(role: string | null | undefined): role is WorkflowRole {
  return Boolean(role && (CAPTAIN_OWNED_ROLES as readonly string[]).includes(role));
}
