import { readFileSync } from "node:fs";
import { loadConfig } from "../config/load.ts";
import type { TeamConfig } from "../config/schema.ts";
import type { WorkflowRole } from "../config/schema.ts";
import { StateDatabase, type NewJob } from "../db/database.ts";
import { sha256 } from "../hash.ts";
import { formatIso, nowEpoch, nowIso } from "../time.ts";
import { LinearTransport } from "../transport.ts";
import { renderEvent } from "./inbox-v6.ts";
import { optionValue } from "./args.ts";
import { synchronizeReceiptCaptainComments } from "./receipt-sync.ts";
import { isCaptainOwnedRole, isFirstmateOwnedRole, resolvePreferredRole } from "../workflow/roles.ts";
import { WORKFLOW_ROLES } from "../config/schema.ts";

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
    && (WORKFLOW_ROLES as readonly string[]).includes(expected.slice("board:".length))
    && Boolean(team.roles[expected.slice("board:".length) as WorkflowRole]);
  if (!fixed && !status && !board) throw new Error(`unsupported --next event: ${expected}`);
}

function roleForAction(verb: string, verdict: string | null, owner: string | null, team: TeamConfig, explicit: string | null): WorkflowRole | null {
  if (explicit && !(WORKFLOW_ROLES as readonly string[]).includes(explicit)) throw new Error(`unknown workflow role: ${explicit}`);
  if (explicit) return explicit as WorkflowRole;
  if (verb === "complete") return "done";
  if (verb === "cancel") return "canceled";
  if (verb === "handoff-to-captain") {
    const resolution = resolvePreferredRole(team, "review-gate", ["decision-captain"]);
    return resolution.kind === "move" ? resolution.role : null;
  }
  if (verdict === "question" || owner === "captain") return team.roles["decision-captain"] ? "decision-captain" : null;
  if (verdict === "approved") return team.roles.validating ? "validating" : "building";
  if (verdict === "changes-requested" || owner === "firstmate") return "building";
  return null;
}

export async function runActV6(args: string[], env: NodeJS.ProcessEnv = process.env, dependencies: { transport?: LinearTransport } = {}): Promise<number> {
  const verb = args[0] ?? "";
  const issue = args[1] ?? "";
  if (!TEXT_VERBS.has(verb) && verb !== "status" && verb !== "send") {
    process.stderr.write("Usage: fm-linear act reply|comment|handoff-to-captain|complete|cancel|status|send ISSUE [flags]\n");
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
    const explicitRole = optionValue(args, "--role")?.trim() || null;
    const expected = optionValue(args, "--next")?.trim() || null;
    const task = optionValue(args, "--task")?.trim() || null;
    const taskHome = optionValue(args, "--home")?.trim() || null;
    const by = optionValue(args, "--by")?.trim() || null;
    const receipt = optionValue(args, "--receipt");
    if (!receipt) throw new Error(`${verb} requires an inbox receipt`);
    db = StateDatabase.open(env);
    const receiptState = db.receipt(receipt);
    if (!receiptState || receiptState.consumed_at) throw new Error(`receipt missing or already consumed: ${receipt}`);
    const snapshot = await synchronizeReceiptCaptainComments({
      db, receiptId: receipt, issue, config, env,
      transport: dependencies.transport,
    });
    if (verdict && !VERDICTS.has(verdict)) throw new Error(`unknown verdict: ${verdict}`);
    if (owner && !OWNERS.has(owner)) throw new Error(`unknown owner: ${owner}`);
    if (verb === "status" && !explicitRole) throw new Error("status requires --role");
    const requiresPromise = config.promises?.required_on_firstmate_owned ?? true;
    if (PROMISE_VERBS.has(verb) && isFirstmateOwnedRole(snapshot?.role) && requiresPromise && !expected) {
      throw new Error("captain-facing replies on firstmate-owned issues must carry --next/--by; use `--next none` if nothing is expected.");
    }
    if (by && !expected) throw new Error("--by requires --next");
    if (expected) validateExpected(expected, team, config.promises?.vocabulary ?? ["status:*", "board:*", "pr-reported", "pr-green", "pr-merged", "comment", "dispatch", "none"]);
    if (expected && expected !== "none" && !by) throw new Error("--next requires --by");
    if (expected === "none" && by) throw new Error("--next none does not accept --by");
    if (expected && !PROMISE_VERBS.has(verb)) throw new Error("--next is only valid for reply, comment, or handoff-to-captain");
    const promiseSeconds = expected && expected !== "none" && by ? durationSeconds(by) : null;
    if (TEXT_VERBS.has(verb) && isCaptainOwnedRole(snapshot?.role) && (!verdict || !owner)) {
      throw new Error("a text-bearing gate write requires --verdict and --to");
    }
    if (TEXT_VERBS.has(verb) && !text) throw new Error(`${verb} requires --comment or --comment-file`);
    if (verb === "send" && (!text || !task)) throw new Error("send requires --task and --comment or --comment-file");
    const nextLine = expected ? (expected === "none" ? "none" : `${expected} by ${by}`) : null;
    const rendered = TEXT_VERBS.has(verb) ? renderReply(text, verdict, nextLine, config.templates.reply) : "";
    if (TEXT_VERBS.has(verb)) lintReply(rendered);
    const target = roleForAction(verb, verdict, owner, team, explicitRole);
    const keyBase = `${receipt}:${verb}:${issue}`;
    const jobs: NewJob[] = [];
    if (verb === "send") jobs.push({ key: `${keyBase}:send:${task}`, kind: "fleet.send", target: task!, payload: { issue, task, home: taskHome, message: text } });
    if (text) {
      if (verb !== "send") jobs.push({ key: `${keyBase}:comment:${sha256(rendered)}`, kind: "linear.comment", target: issue, payload: { issue, body: rendered, actor: "core", requires_managed: true } });
    }
    if (target) {
      jobs.push({ key: `${keyBase}:role:${target}`, kind: "linear.issue-role", target: issue, payload: { issue, role: target, expected_role: snapshot.role, actor: "core", requires_managed: true } });
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
