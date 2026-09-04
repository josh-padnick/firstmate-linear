import type { WorkflowConfig } from "../config/schema.ts";
import type { NewJob, StateDatabase } from "../db/database.ts";
import { nowEpoch, nowIso, parseIso } from "../time.ts";

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
  const existingJobs = new Set(db.jobs().map((job) => job.key));
  for (const event of db.listEvents(["waiting-for-core"])) {
    if (event.type === "resumed") continue;
    const stalled = event.token === "stalled";
    let escalationAt = event.created_at;
    let escalationKey = event.id;
    if (stalled) {
      try {
        const raw = JSON.parse(event.raw_ref) as { escalation_key?: unknown; stalled_at?: unknown };
        if (typeof raw.escalation_key === "string") escalationKey = raw.escalation_key;
        if (typeof raw.stalled_at === "string") escalationAt = raw.stalled_at;
      } catch {}
    }
    const created = parseIso(escalationAt);
    if (created === null) continue;
    const age = Math.max(0, now - created);
    const deadline = stalled
      ? config.deadlines?.stalled.mention ?? 30 * 60
      : TOKEN_DEADLINES[event.token] ?? 60 * 60;
    if (age < deadline) continue;
    const rung = stalled ? "mention" : age >= 24 * 3600 ? "24h" : age >= 3600 ? "1h" : "initial";
    const body = stalled
      ? `${config.captain.display_name}: Firstmate has not handled this stalled issue after ${Math.floor(age / 60)} minutes. ${event.note ?? "Open the Firstmate inbox for the specific overdue action."}`
      : `${config.captain.display_name}: Firstmate still needs your input on this issue (${event.token}, waiting ${Math.floor(age / 60)} minutes).`;
    const key = `${escalationKey}:escalation:${rung}`;
    if (existingJobs.has(key)) continue;
    out.push({
      eventId: event.id, issue: event.issue, ageSeconds: age,
      job: {
        key, kind: "linear.comment", target: event.issue,
        payload: { issue: event.issue, body, waiting_event_id: event.id },
      },
    });
  }
  return out;
}

export function applyEscalations(db: StateDatabase, config: WorkflowConfig, env: NodeJS.ProcessEnv = process.env): number {
  const plan = planEscalations(db, config, env);
  if (config.features.escalation !== "on") return 0;
  return db.transaction(() => {
    for (const item of plan) db.enqueue(item.job, nowIso(env));
    return plan.length;
  });
}
