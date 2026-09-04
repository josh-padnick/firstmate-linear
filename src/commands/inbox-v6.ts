import { StateDatabase, type DomainEvent } from "../db/database.ts";
import { optionValue } from "./args.ts";

const PENDING = ["waiting-for-core"] as const;

export function renderEvent(event: DomainEvent): string {
  let body = event.raw_ref;
  try { body = JSON.stringify(JSON.parse(event.raw_ref), null, 2); } catch { /* retain raw */ }
  return [
    `${event.id} ${event.token} ${event.issue}`,
    `author: ${event.author}`,
    `created: ${event.created_at}`,
    `required: read the complete event below before acting`,
    `then: use fm-linear act with this receipt, or inbox handle if no write is needed`,
    "----- BEGIN EVENT -----",
    body,
    "----- END EVENT -----",
  ].join("\n");
}

export function runInboxV6(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const db = StateDatabase.open(env);
  try {
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
        process.stdout.write(`${renderEvent(event)}\nreceipt: ${receipt}\n`);
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
      db.handleWithReceipt(event.id, receiptId, note);
      process.stdout.write(`fm-linear inbox: handled ${event.id}\n`);
      return 0;
    }
    process.stderr.write("Usage: fm-linear inbox list|show [event-id]|handle <event-id> --receipt <id>\n");
    return 2;
  } finally { db.close(); }
}
