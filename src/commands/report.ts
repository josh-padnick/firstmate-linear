import { readFileSync } from "node:fs";
import { loadConfig } from "../config/load.ts";
import { StateDatabase, type DomainEvent } from "../db/database.ts";
import { nowIso } from "../time.ts";

function template(path: string, values: Record<string, string>): string {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch { text = "# Firstmate Linear report\n\n{{summary}}\n\n{{events}}\n\n{{drift}}\n"; }
  return text.replace(/\{\{([a-z_]+)\}\}/g, (_, key: string) => values[key] ?? "");
}

function commentThreadRoot(event: DomainEvent): string | null {
  if (event.type !== "comment") return null;
  try {
    const raw = JSON.parse(event.raw_ref) as { comment_id?: unknown; parent_id?: unknown };
    if (typeof raw.parent_id === "string" && raw.parent_id) return raw.parent_id;
    return typeof raw.comment_id === "string" && raw.comment_id ? raw.comment_id : null;
  } catch { return null; }
}

function renderEventGroups(events: DomainEvent[]): string {
  if (!events.length) return "No new Linear events.";
  const rows: Array<{ kind: "event"; event: DomainEvent } | { kind: "thread"; issue: string; root: string; events: DomainEvent[] }> = [];
  const threads = new Map<string, Extract<(typeof rows)[number], { kind: "thread" }>>();
  for (const event of events) {
    const root = commentThreadRoot(event);
    if (!root) {
      rows.push({ kind: "event", event });
      continue;
    }
    const key = `${event.issue}\0${root}`;
    let thread = threads.get(key);
    if (!thread) {
      thread = { kind: "thread", issue: event.issue, root, events: [] };
      threads.set(key, thread);
      rows.push(thread);
    }
    thread.events.push(event);
  }
  return rows.map((row) => {
    if (row.kind === "event") return `- ${row.event.created_at} ${row.event.issue} ${row.event.token}: ${row.event.note ?? row.event.disposition}`;
    const latest = row.events.at(-1)!;
    return `- ${row.issue} thread ${row.root}: ${row.events.length} comment${row.events.length === 1 ? "" : "s"}; latest ${latest.created_at} ${latest.author}`;
  }).join("\n");
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
    const restarted = observations.some((observation) => observation.verb === "service-restarted");
    const summary = [
      `Window: ${cursor ?? "beginning"} to ${nowIso(env)}`,
      `Captured: ${events.length}; pending: ${pending}; relayed: ${relayed}; job problems: ${jobs.length}.`,
      restarted ? "The service restarted after its poll watchdog fired and reconciled immediately."
        : resumed ? "The service resumed after a polling gap and reconciled immediately."
          : "No resume gap or watchdog restart was recorded in this window.",
    ].join("\n");
    const eventLines = renderEventGroups(events);
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
