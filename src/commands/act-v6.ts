import { readFileSync } from "node:fs";
import { loadConfig } from "../config/load.ts";
import type { TeamConfig } from "../config/schema.ts";
import { StateDatabase, type NewJob } from "../db/database.ts";
import { sha256 } from "../hash.ts";
import { formatIso, nowEpoch, nowIso } from "../time.ts";
import { LinearTransport } from "../transport.ts";
import { renderEvent } from "./inbox-v6.ts";
import { optionValue } from "./args.ts";
import { synchronizeReceiptCaptainComments } from "./receipt-sync.ts";

const TEXT_VERBS = new Set(["reply", "comment", "handoff-to-captain", "complete", "cancel"]);
const VERDICTS = new Set(["approved", "changes-requested", "question"]);
const OWNERS = new Set(["captain", "firstmate", "none"]);
const PROMISE_VERBS = new Set(["reply", "comment", "handoff-to-captain"]);

function body(args: string[]): string {
  const file = optionValue(args, "--comment-file");
  return file ? readFileSync(file, "utf8") : optionValue(args, "--comment") ?? "";
}

function teamFor(issue: string, teams: TeamConfig[]): TeamConfig {
  const key = issue.slice(0, issue.indexOf("-")).toUpperCase();
  const team = teams.find((item) => item.key === key);
  if (!team || !new RegExp(`^${team.key}-\\d+$`).test(issue)) throw new Error(`unmanaged issue identifier: ${issue}`);
  return team;
}

function lintReply(text: string): void {
  if (text.split(/\r?\n/).length > 8) throw new Error("reply-max-lines: reply exceeds 8 lines");
  if (/^\s*(done|working|blocked|paused|failed|resolved)\s*:/i.test(text)) {
    throw new Error("reply-no-status-verb-lead: reply begins with a worker status verb");
  }
}

function renderReply(text: string, verdict: string | null, next: string | null, path: string): string {
  let template = "{{body}}\n\nNext: {{next}}\n\nVerdict: {{verdict}}\n";
  try { template = readFileSync(path, "utf8"); } catch { /* use safe built-in template */ }
  if (!verdict) template = template.replace(/^.*\{\{verdict\}\}.*(?:\r?\n|$)/gm, "");
  if (!next) template = template.replace(/^.*\{\{next\}\}.*(?:\r?\n|$)/gm, "");
  else if (!template.includes("{{next}}")) template = `${template.trimEnd()}\n\nNext: ${next}\n`;
  const rendered = template.replaceAll("{{body}}", text).replaceAll("{{verdict}}", verdict ?? "").replaceAll("{{next}}", next ?? "").trim();
  if (/\{\{[^}]+\}\}/.test(rendered)) throw new Error("reply template has unresolved placeholders");
  return rendered;
}

function durationSeconds(value: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error("--by must be a duration such as 20m or 2h");
  const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = Number(match[1]) * units[match[2]!]!;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("--by must be a positive duration");
  return seconds;
}

function validateExpected(expected: string, team: TeamConfig, vocabulary: string[]): void {
  const fixed = vocabulary.includes(expected);
  const status = vocabulary.includes("status:*") && /^status:[a-z][a-z0-9-]*$/.test(expected);
  const board = vocabulary.includes("board:*") && expected.startsWith("board:")
    && Object.values(team.statuses).includes(expected.slice("board:".length));
  if (!fixed && !status && !board) throw new Error(`unsupported --next event: ${expected}`);
}

function statusFor(verb: string, verdict: string | null, owner: string | null, team: TeamConfig, explicit: string | null): string | null {
  if (explicit) return explicit;
  if (verb === "complete") return team.statuses.done;
  if (verb === "cancel") return team.statuses.canceled;
  if (verb === "handoff-to-captain") return team.statuses.approve_deliverable;
  if (verdict === "question" || owner === "captain") return team.statuses.needs_decision;
  if (verdict === "approved") return team.statuses.validating_code;
  if (verdict === "changes-requested" || owner === "firstmate") return team.statuses.building;
  return null;
}

export async function runActV6(args: string[], env: NodeJS.ProcessEnv = process.env, dependencies: { transport?: LinearTransport } = {}): Promise<number> {
  const verb = args[0] ?? "";
  const issue = args[1] ?? "";
  if (!TEXT_VERBS.has(verb) && verb !== "status") {
    process.stderr.write("Usage: fm-linear act reply|comment|handoff-to-captain|complete|cancel|status ISSUE [flags]\n");
    return 2;
  }
  const config = loadConfig(env);
  let db: StateDatabase | null = null;
  try {
    if (args.includes("--actor")) throw new Error("--actor is reserved for the service and is not a public override");
    const team = teamFor(issue, config.teams);
    const text = body(args).trim();
    const verdict = optionValue(args, "--verdict");
    const owner = optionValue(args, "--to");
    const explicitStatus = optionValue(args, "--status")?.trim() || null;
    const expected = optionValue(args, "--next")?.trim() || null;
    const by = optionValue(args, "--by")?.trim() || null;
    if (verdict && !VERDICTS.has(verdict)) throw new Error(`unknown verdict: ${verdict}`);
    if (owner && !OWNERS.has(owner)) throw new Error(`unknown owner: ${owner}`);
    if (verb === "status" && !explicitStatus) throw new Error("status requires --status");
    db = StateDatabase.open(env);
    const snapshot = db.latestSnapshot(issue);
    if (snapshot?.managed === false) throw new Error(`issue is no longer managed: ${issue}`);
    const firstmateOwned = new Set([
      team.statuses.plan_in_progress, team.statuses.building, team.statuses.validating_code,
      team.statuses.waiting, team.statuses.needs_firstmate_decision,
    ]);
    const requiresPromise = config.promises?.required_on_firstmate_owned ?? true;
    if (PROMISE_VERBS.has(verb) && firstmateOwned.has(snapshot?.state ?? "") && requiresPromise && !expected) {
      throw new Error("captain-facing replies on firstmate-owned issues must carry --next/--by; use `--next none` if nothing is expected.");
    }
    if (by && !expected) throw new Error("--by requires --next");
    if (expected) validateExpected(expected, team, config.promises?.vocabulary ?? ["status:*", "board:*", "pr-reported", "pr-green", "pr-merged", "comment", "dispatch", "none"]);
    if (expected && expected !== "none" && !by) throw new Error("--next requires --by");
    if (expected === "none" && by) throw new Error("--next none does not accept --by");
    if (expected && !PROMISE_VERBS.has(verb)) throw new Error("--next is only valid for reply, comment, or handoff-to-captain");
    const promiseSeconds = expected && expected !== "none" && by ? durationSeconds(by) : null;
    const gates = new Set([team.statuses.approve_plan, team.statuses.approve_deliverable, team.statuses.needs_decision]);
    if (TEXT_VERBS.has(verb) && gates.has(snapshot?.state ?? "") && (!verdict || !owner)) {
      throw new Error("a text-bearing gate write requires --verdict and --to");
    }
    if (TEXT_VERBS.has(verb) && !text) throw new Error(`${verb} requires --comment or --comment-file`);
    const nextLine = expected ? (expected === "none" ? "none" : `${expected} by ${by}`) : null;
    const rendered = TEXT_VERBS.has(verb) ? renderReply(text, verdict, nextLine, config.templates.reply) : "";
    if (TEXT_VERBS.has(verb)) lintReply(rendered);
    const target = statusFor(verb, verdict, owner, team, explicitStatus);
    const receipt = optionValue(args, "--receipt");
    if (!receipt) throw new Error(`${verb} requires an inbox receipt`);
    const receiptState = db.receipt(receipt);
    if (!receiptState || receiptState.consumed_at) throw new Error(`receipt missing or already consumed: ${receipt}`);
    await synchronizeReceiptCaptainComments({
      db, receiptId: receipt, issue, team, captain: config.captain.display_name, env,
      transport: dependencies.transport,
    });
    const keyBase = `${receipt}:${verb}:${issue}`;
    const jobs: NewJob[] = [];
    if (text) {
      jobs.push({ key: `${keyBase}:comment:${sha256(rendered)}`, kind: "linear.comment", target: issue, payload: { issue, body: rendered, actor: "core", requires_managed: true } });
    }
    if (target) {
      jobs.push({ key: `${keyBase}:state:${target}`, kind: "linear.issue-state", target: issue, payload: { issue, state: target, expected_state: snapshot?.state ?? null, actor: "core", requires_managed: true } });
    }
    let handled: string[] = [];
    const createdAt = nowIso(env);
    handled = db.actWithReceipt({
      receiptId: receipt,
      issue,
      captain: config.captain.display_name,
      jobs,
      note: `${verb}${verdict ? ` verdict=${verdict}` : ""}`,
      at: createdAt,
      promise: expected && expected !== "none" && promiseSeconds
        ? { issue, expected_event: expected, deadline_at: formatIso(nowEpoch(env) + promiseSeconds), created_at: createdAt }
        : undefined,
    });
    process.stdout.write(`fm-linear act ${verb}: queued ${jobs.length} job(s)${handled.length ? `; handled ${handled.join(",")}` : ""}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const staleId = /^stale receipt: newer captain event (\S+)/.exec(message)?.[1];
    const newer = staleId && db ? db.event(staleId) : null;
    process.stderr.write(`fm-linear act: ${message}${newer ? `\n${renderEvent(newer)}\nthen: run fm-linear inbox show ${newer.id} to issue a fresh receipt` : ""}\n`);
    return 1;
  } finally { db?.close(); }
}
