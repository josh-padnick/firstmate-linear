import { StateDatabase, type DomainEvent } from "../db/database.ts";
import { optionValue } from "./args.ts";
import { loadConfig } from "../config/load.ts";
import { resolveHome } from "../env.ts";
import { firstmateOwnedStatuses } from "../reconcile/stall.ts";
import { buildIssueStatus, isCaptainStatusQuery } from "./status.ts";
import type { LinearTransport } from "../transport.ts";
import { synchronizeReceiptCaptainComments } from "./receipt-sync.ts";

const PENDING = ["waiting-for-core"] as const;

function rawObject(event: DomainEvent): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(event.raw_ref) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

export function renderEvent(event: DomainEvent, statusFacts: string | null = null): string {
  let body = event.raw_ref;
  try { body = JSON.stringify(JSON.parse(event.raw_ref), null, 2); } catch { /* retain raw */ }
  const raw = rawObject(event);
  const concrete = event.token === "stalled" && typeof raw?.required === "string"
    ? raw.required
    : "read the complete event below before acting";
  const required = statusFacts
    ? `ground your reply in these observed issue facts:\n${statusFacts}\nrequired action: ${concrete}`
    : concrete;
  return [
    `${event.id} ${event.token} ${event.issue}`,
    `author: ${event.author}`,
    `created: ${event.created_at}`,
    `required: ${required}`,
    `then: use fm-linear act with this receipt, or inbox handle if no write is needed`,
    "----- BEGIN EVENT -----",
    body,
    "----- END EVENT -----",
  ].join("\n");
}

export async function runInboxV6(args: string[], env: NodeJS.ProcessEnv = process.env, dependencies: { transport?: LinearTransport } = {}): Promise<number> {
  const db = StateDatabase.open(env);
  try {
    const config = loadConfig(env);
    const sub = args[0] ?? "list";
    if (sub === "list") {
      const events = db.listEvents([...PENDING]);
      if (!events.length) process.stdout.write("fm-linear inbox: empty\n");
      else for (const event of events) process.stdout.write(`${event.id} ${event.token} ${event.issue} ${event.created_at}\n`);
      return 0;
    }
    if (sub === "show") {
      const requested = args[1];
      const events = requested
        ? [db.findEvent(requested)].filter((item): item is DomainEvent => item !== null)
        : db.listEvents([...PENDING]);
      if (!events.length) {
        process.stderr.write(requested ? `fm-linear inbox: event not found: ${requested}\n` : "fm-linear inbox: empty\n");
        return requested ? 1 : 0;
      }
      for (const event of events) {
        if (event.disposition !== "waiting-for-core") {
          process.stdout.write(`${event.id} is already ${event.disposition}; no receipt issued\n`);
          continue;
        }
        const receipt = db.issueReceipt([event.id]);
        const raw = rawObject(event);
        const team = config.teams.find((item) => item.key === event.team);
        const snapshot = db.latestSnapshot(event.issue);
        const statusFacts = event.author === config.captain.display_name
          && event.type === "comment"
          && typeof raw?.body === "string"
          && isCaptainStatusQuery(raw.body)
          && team
          && firstmateOwnedStatuses(team).has(snapshot?.state ?? "")
          ? buildIssueStatus(resolveHome(env), db, event.issue)
          : null;
        process.stdout.write(`${renderEvent(event, statusFacts)}\nreceipt: ${receipt}\n`);
      }
      return 0;
    }
    if (sub === "handle") {
      const id = args[1];
      const receiptId = optionValue(args, "--receipt");
      const note = optionValue(args, "--note") ?? "handled";
      if (!id || !receiptId) {
        process.stderr.write("Usage: fm-linear inbox handle <event-id> --receipt <receipt-id> [--note text]\n");
        return 2;
      }
      const receipt = db.receipt(receiptId);
      const event = db.findEvent(id);
      if (!receipt || receipt.consumed_at || !event || !receipt.event_ids.includes(event.id)) {
        process.stderr.write("fm-linear inbox: receipt does not authorize that event\n");
        return 1;
      }
      try {
        const team = config.teams.find((item) => item.key === event.team);
        if (!team) throw new Error(`unmanaged team: ${event.team}`);
        await synchronizeReceiptCaptainComments({
          db, receiptId, issue: event.issue, team, captain: config.captain.display_name, env,
          transport: dependencies.transport,
        });
        db.handleWithReceipt(event.id, receiptId, config.captain.display_name, note);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const staleId = /^stale receipt: newer captain event (\S+)/.exec(message)?.[1];
        const newer = staleId ? db.event(staleId) : null;
        process.stderr.write(`fm-linear inbox: ${message}${newer ? `\n${renderEvent(newer)}\nthen: run fm-linear inbox show ${newer.id} to issue a fresh receipt` : ""}\n`);
        return 1;
      }
      process.stdout.write(`fm-linear inbox: handled ${event.id}\n`);
      return 0;
    }
    process.stderr.write("Usage: fm-linear inbox list|show [event-id]|handle <event-id> --receipt <id>\n");
    return 2;
  } finally { db.close(); }
}
