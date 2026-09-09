import type { TeamConfig } from "./config/schema.ts";

export type ManagedIssue = {
  assignee?: { displayName?: string | null } | null;
  project?: { name?: string | null; slugId?: string | null } | null;
};

export function isManagedIssue(team: Pick<TeamConfig, "managed" | "projects">, viewer: string, issue: ManagedIssue): boolean {
  const assigned = team.managed === "all" || issue.assignee?.displayName === viewer;
  if (!assigned || team.projects.length === 0) return assigned;
  const allowed = new Set(team.projects.map((item) => item.toLowerCase()));
  return allowed.has(issue.project?.name?.toLowerCase() ?? "")
    || allowed.has(issue.project?.slugId?.toLowerCase() ?? "");
}
