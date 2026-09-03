import { readFileSync } from "node:fs";
import { loadConfig } from "../config/load.ts";
import type { TeamConfig } from "../config/schema.ts";
import { StateDatabase, type NewJob } from "../db/database.ts";
import { sha256 } from "../hash.ts";
import { renderEvent } from "./inbox-v6.ts";

const TEXT_VERBS = new Set(["reply", "comment", "handoff-to-captain", "complete", "cancel"]);
const VERDICTS = new Set(["approved", "changes-requested", "question"]);
const OWNERS = new Set(["captain", "firstmate", "none"]);

function flag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function body(args: string[]): string {
  const file = flag(args, "--comment-file");
  return file ? readFileSync(file, "utf8") : flag(args, "--comment") ?? "";
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

function renderReply(text: string, verdict: string | null, path: string): string {
  let template = "{{body}}\n\nVerdict: {{verdict}}\n";
  try { template = readFileSync(path, "utf8"); } catch { /* use safe built-in template */ }
  if (!verdict) template = template.replace(/^.*\{\{verdict\}\}.*(?:\r?\n|$)/gm, "");
  const rendered = template.replaceAll("{{body}}", text).replaceAll("{{verdict}}", verdict ?? "").trim();
  if (/\{\{[^}]+\}\}/.test(rendered)) throw new Error("reply template has unresolved placeholders");
  return rendered;
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

export function runActV6(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const verb = args[0] ?? "";
  const issue = args[1] ?? "";
  if (!TEXT_VERBS.has(verb) && verb !== "status") {
    process.stderr.write("Usage: fm-linear act reply|comment|handoff-to-captain|complete|cancel|status ISSUE [flags]\n");
    return 2;
  }
  const config = loadConfig(env);
  let db: StateDatabase | null = null;
  try {
    if (flag(args, "--actor")) throw new Error("--actor is reserved for the service and is not a public override");
    const team = teamFor(issue, config.teams);
    const text = body(args).trim();
    const verdict = flag(args, "--verdict");
    const owner = flag(args, "--to");
    const explicitStatus = flag(args, "--status")?.trim() || null;
    if (verdict && !VERDICTS.has(verdict)) throw new Error(`unknown verdict: ${verdict}`);
    if (owner && !OWNERS.has(owner)) throw new Error(`unknown owner: ${owner}`);
    if (verb === "status" && !explicitStatus) throw new Error("status requires --status");
    db = StateDatabase.open(env);
    const snapshot = db.latestSnapshot(issue);
    const gates = new Set([team.statuses.approve_plan, team.statuses.approve_deliverable, team.statuses.needs_decision]);
    if (TEXT_VERBS.has(verb) && gates.has(snapshot?.state ?? "") && (!verdict || !owner)) {
      throw new Error("a text-bearing gate write requires --verdict and --to");
    }
    if (TEXT_VERBS.has(verb) && !text) throw new Error(`${verb} requires --comment or --comment-file`);
    const rendered = TEXT_VERBS.has(verb) ? renderReply(text, verdict, config.templates.reply) : "";
    if (TEXT_VERBS.has(verb)) lintReply(rendered);
    const target = statusFor(verb, verdict, owner, team, explicitStatus);
    const receipt = flag(args, "--receipt");
    if (!receipt) throw new Error(`${verb} requires an inbox receipt`);
    const keyBase = `${receipt}:${verb}:${issue}`;
    const jobs: NewJob[] = [];
    if (text) {
      jobs.push({ key: `${keyBase}:comment:${sha256(rendered)}`, kind: "linear.comment", target: issue, payload: { issue, body: rendered } });
    }
    if (target) {
      jobs.push({ key: `${keyBase}:state:${target}`, kind: "linear.issue-state", target: issue, payload: { issue, state: target, expected_state: snapshot?.state ?? null, actor: "core" } });
    }
    let handled: string[] = [];
    handled = db.actWithReceipt({ receiptId: receipt, issue, captain: config.captain.display_name, jobs, note: `${verb}${verdict ? ` verdict=${verdict}` : ""}` });
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
