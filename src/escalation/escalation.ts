import type { WorkflowConfig } from "../config/schema.ts";
import type { NewJob, StateDatabase } from "../db/database.ts";
import { nowEpoch, parseIso } from "../time.ts";

const TOKEN_DEADLINES: Record<string, number> = {
  "start-now": 5 * 60,
  "plan-approved": 5 * 60,
  "ball-returned": 5 * 60,
  approval: 5 * 60,
  comment: 30 * 60,
  "scope-changed": 30 * 60,
  resumed: 5 * 60,
};

export type Escalation = { eventId: string; issue: string; ageSeconds: number; job: NewJob };

export function planEscalations(db: StateDatabase, config: WorkflowConfig, env: NodeJS.ProcessEnv = process.env): Escalation[] {
  const now = nowEpoch(env);
  const out: Escalation[] = [];
  for (const event of db.listEvents(["waiting-for-core"])) {
    const created = parseIso(event.created_at);
    if (created === null) continue;
    const age = Math.max(0, now - created);
    const deadline = TOKEN_DEADLINES[event.token] ?? 60 * 60;
    if (age < deadline) continue;
    const rung = age >= 24 * 3600 ? "24h" : age >= 3600 ? "1h" : "initial";
    out.push({
      eventId: event.id, issue: event.issue, ageSeconds: age,
      job: {
        key: `${event.id}:escalation:${rung}`, kind: "linear.comment", target: event.issue,
        payload: { issue: event.issue, body: `${config.captain.display_name}: Firstmate still needs your input on this issue (${event.token}, waiting ${Math.floor(age / 60)} minutes).` },
      },
    });
  }
  return out;
}

export function applyEscalations(db: StateDatabase, config: WorkflowConfig, env: NodeJS.ProcessEnv = process.env): number {
  const plan = planEscalations(db, config, env);
  if (config.features.escalation !== "on") return 0;
  return db.transaction(() => {
    for (const item of plan) db.enqueue(item.job);
    return plan.length;
  });
}
