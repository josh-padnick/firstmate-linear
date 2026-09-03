import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowConfig } from "../config/schema.ts";
import type { NewJob, StateDatabase } from "../db/database.ts";
import { nowEpoch, parseIso } from "../time.ts";
import { checkReview } from "./review.ts";

export type ReviewFinding = { code: string; issue: string; detail: string };

export function planReviewDeadlines(home: string, db: StateDatabase, config: WorkflowConfig, env: NodeJS.ProcessEnv = process.env): { jobs: NewJob[]; findings: ReviewFinding[] } {
  const jobs: NewJob[] = [];
  const findings: ReviewFinding[] = [];
  const now = nowEpoch(env);
  for (const snapshot of db.latestSnapshots()) {
    const teamKey = snapshot.issue.slice(0, snapshot.issue.indexOf("-")).toUpperCase();
    const team = config.teams.find((item) => item.key === teamKey);
    if (!team || snapshot.state !== team.statuses.approve_deliverable) continue;
    const green = db.observations(snapshot.issue).filter((item) => item.verb === "pr-green").at(-1);
    if (!green) continue;
    const path = join(home, "data", snapshot.issue.toLowerCase(), "review-walkthrough.html");
    let errors: string[];
    if (!existsSync(path)) errors = ["walkthrough file is missing"];
    else {
      try { errors = checkReview(path); }
      catch (error) { errors = [error instanceof Error ? error.message : String(error)]; }
    }
    if (!errors.length) continue;
    findings.push({ code: "WALKTHROUGH_INVALID", issue: snapshot.issue, detail: errors.join("; ") });
    const observed = parseIso(green.observed_at);
    if (observed === null) continue;
    const age = Math.max(0, now - observed);
    if (age < 15 * 60) continue;
    const rung = age >= 45 * 60 ? "45m" : "15m";
    const prefix = rung === "45m" ? `${config.captain.display_name}: ` : "";
    jobs.push({
      key: `${green.id}:walkthrough:${rung}`,
      kind: "linear.comment",
      target: snapshot.issue,
      payload: { issue: snapshot.issue, body: `${prefix}The review walkthrough is still incomplete after ${rung}. ${errors.join("; ")}.` },
    });
  }
  return { jobs, findings };
}

export function applyReviewDeadlines(db: StateDatabase, config: WorkflowConfig, plan: { jobs: NewJob[] }): number {
  if (config.features.mirror !== "on") return 0;
  return db.transaction(() => {
    for (const job of plan.jobs) db.enqueue(job);
    return plan.jobs.length;
  });
}
