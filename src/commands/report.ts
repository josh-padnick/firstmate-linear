import { readFileSync } from "node:fs";
import { loadConfig } from "../config/load.ts";
import { StateDatabase } from "../db/database.ts";
import { nowIso } from "../time.ts";

function template(path: string, values: Record<string, string>): string {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch { text = "# Firstmate Linear report\n\n{{summary}}\n\n{{events}}\n\n{{drift}}\n"; }
  return text.replace(/\{\{([a-z_]+)\}\}/g, (_, key: string) => values[key] ?? "");
}

export function runReport(_args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const config = loadConfig(env);
  const db = StateDatabase.open(env);
  try {
    const cursor = db.consumerCursor("report");
    let eventRowid = 0;
    let observationRowid = 0;
    try {
      const parsed = JSON.parse(cursor ?? "{}") as { event_rowid?: number; observation_rowid?: number };
      if (Number.isSafeInteger(parsed.event_rowid) && parsed.event_rowid! >= 0) eventRowid = parsed.event_rowid!;
      if (Number.isSafeInteger(parsed.observation_rowid) && parsed.observation_rowid! >= 0) observationRowid = parsed.observation_rowid!;
    } catch { /* an older timestamp cursor intentionally replays once */ }
    const eventBatch = db.eventsAfterRowid(eventRowid);
    const observationBatch = db.observationsAfterRowid(observationRowid);
    const events = eventBatch.map((item) => item.event);
    const observations = observationBatch.map((item) => item.observation);
    const jobs = db.jobs(["retry", "dead"]);
    const relayed = events.filter((event) => event.disposition === "handled-by-service" && event.note?.startsWith("relayed")).length;
    const pending = db.listEvents(["waiting-for-core"]).length;
    const resumed = events.some((event) => event.token === "resumed");
    const summary = [
      `Window: ${cursor ?? "beginning"} to ${nowIso(env)}`,
      `Captured: ${events.length}; pending: ${pending}; relayed: ${relayed}; job problems: ${jobs.length}.`,
      resumed ? "The service resumed after a polling gap and reconciled immediately." : "No resume gap was recorded in this window.",
    ].join("\n");
    const eventLines = events.length ? events.map((event) => `- ${event.created_at} ${event.issue} ${event.token}: ${event.note ?? event.disposition}`).join("\n") : "No new Linear events.";
    const driftLines = jobs.length
      ? jobs.map((job) => `- ${job.target} ${job.kind} ${job.state}: ${job.last_error ?? "pending retry"}`).join("\n")
      : observations.some((item) => item.verb.startsWith("finding-"))
        ? observations.filter((item) => item.verb.startsWith("finding-")).map((item) => `- ${item.issue} ${item.key}: ${item.note}`).join("\n")
        : observations.length ? `Observed ${observations.length} fleet signal(s); no failed repair jobs.` : "No drift or new fleet signals.";
    process.stdout.write(template(config.templates.report, { summary, events: eventLines, drift: driftLines }));
    const next = {
      event_rowid: eventBatch.at(-1)?.rowid ?? eventRowid,
      observation_rowid: observationBatch.at(-1)?.rowid ?? observationRowid,
    };
    db.setConsumerCursor("report", JSON.stringify(next), nowIso(env));
    return 0;
  } finally { db.close(); }
}
