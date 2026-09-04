import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PROGRESS_DEADLINES, type TeamConfig, type WorkflowConfig } from "../config/schema.ts";
import { type DomainEvent, type PromiseRecord, type StateDatabase } from "../db/database.ts";
import { sha256 } from "../hash.ts";
import { compareIso, formatIso, nowEpoch, nowIso, parseIso } from "../time.ts";

export type Progress = { id: string; kind: string; at: string; detail: string };
export type StallResult = { emitted: number; kept: number; overdue: number };

export function firstmateOwnedStatuses(team: TeamConfig): Set<string> {
  return new Set([
    team.statuses.plan_in_progress,
    team.statuses.building,
    team.statuses.validating_code,
    team.statuses.waiting,
    team.statuses.needs_firstmate_decision,
  ]);
}

function atOrAfter(candidate: string, baseline: string): boolean {
  const compared = compareIso(candidate, baseline);
  return compared !== null && compared >= 0;
}

function later(left: Progress | null, right: Progress): Progress {
  if (!left) return right;
  const compared = compareIso(right.at, left.at);
  return compared === 1 || compared === 0 ? right : left;
}

function activePrimaryTasks(db: StateDatabase, issue: string): Set<string> {
  return new Set(db.taskLinks(issue, true).filter((link) => link.role === "primary").map((link) => link.task));
}

function wasPrimaryTaskAt(db: StateDatabase, issue: string, task: string, observedAt: string): boolean {
  return db.taskLinks(issue).some((link) => link.task === task
    && link.role === "primary"
    && atOrAfter(observedAt, link.spawned_at)
    && (!link.torn_down_at || atOrAfter(link.torn_down_at, observedAt)));
}

function matchingObservation(db: StateDatabase, promise: PromiseRecord): Progress | null {
  const observations = db.observations(promise.issue, promise.created_at);
  const expected = promise.expected_event;
  if (expected.startsWith("status:")) {
    const verb = expected.slice("status:".length);
    const found = observations.find((item) => item.source === "status"
      && item.verb === verb
      && item.task
      && wasPrimaryTaskAt(db, promise.issue, item.task, item.observed_at));
    return found ? { id: found.id, kind: "status", at: found.observed_at, detail: `status ${verb}` } : null;
  }
  if (expected.startsWith("board:")) {
    const state = expected.slice("board:".length);
    const snapshots = db.snapshots(promise.issue);
    const found = snapshots.find((item, index) => index > 0
      && atOrAfter(item.observed_at, promise.created_at)
      && item.state === state
      && snapshots[index - 1]!.state !== state);
    return found ? { id: `snapshot:${promise.issue}:${found.observed_at}`, kind: "board", at: found.observed_at, detail: `board ${state}` } : null;
  }
  if (["pr-reported", "pr-green", "pr-merged"].includes(expected)) {
    const found = observations.find((item) => item.source === "pr"
      && item.verb === expected
      && item.task
      && wasPrimaryTaskAt(db, promise.issue, item.task, item.observed_at));
    return found ? { id: found.id, kind: "pr", at: found.observed_at, detail: expected } : null;
  }
  if (expected === "comment") {
    const found = observations.find((item) => item.verb === "firstmate-comment" && item.key !== promise.reply_comment_id);
    return found ? { id: found.id, kind: "comment", at: found.observed_at, detail: "firstmate comment" } : null;
  }
  if (expected === "dispatch") {
    const found = db.taskLinks(promise.issue, true).find((item) => item.role === "primary" && atOrAfter(item.spawned_at, promise.created_at));
    return found ? { id: `dispatch:${found.task}:${found.spawned_at}`, kind: "dispatch", at: found.spawned_at, detail: `dispatch ${found.task}` } : null;
  }
  return null;
}

export function lastProgress(db: StateDatabase, issue: string): Progress | null {
  const primary = activePrimaryTasks(db, issue);
  let latest: Progress | null = null;
  for (const item of db.observations(issue)) {
    const taskProgress = item.task && primary.has(item.task) && (item.source === "status" || item.source === "pr");
    const serviceProgress = item.verb === "firstmate-comment" || item.verb === "relay";
    if (taskProgress || serviceProgress) latest = later(latest, { id: item.id, kind: item.source, at: item.observed_at, detail: `${item.verb}${item.note ? ` ${item.note}` : ""}` });
  }
  const snapshots = db.snapshots(issue);
  for (let index = 0; index < snapshots.length; index += 1) {
    const item = snapshots[index]!;
    if (index === 0 || snapshots[index - 1]!.state !== item.state) {
      latest = later(latest, { id: `snapshot:${issue}:${item.observed_at}`, kind: "board", at: item.observed_at, detail: item.state });
    }
  }
  for (const link of db.taskLinks(issue, true).filter((item) => item.role === "primary")) {
    latest = later(latest, { id: `dispatch:${link.task}:${link.spawned_at}`, kind: "dispatch", at: link.spawned_at, detail: link.task });
  }
  return latest;
}

function taskBusyState(home: string, task: string): "busy" | "not-busy" {
  const path = join(home, "state", `${task}.busy-state`);
  if (!existsSync(path)) return "not-busy";
  try {
    const text = readFileSync(path, "utf8");
    const match = /^v1 gen=\S+ seq=\d+ state=(busy|idle) source=\S+ event=\S+ ts=\d+\n?$/.exec(text);
    return match?.[1] === "busy" ? "busy" : "not-busy";
  } catch { return "not-busy"; }
}

function busy(home: string, db: StateDatabase, issue: string): boolean {
  for (const link of db.taskLinks(issue, true).filter((item) => item.role === "primary")) {
    if (taskBusyState(home, link.task) === "busy") return true;
  }
  return false;
}

function clock(iso: string): string {
  const epoch = parseIso(iso);
  return epoch === null ? iso : new Date(epoch * 1000).toISOString().slice(11, 16);
}

function requiredFor(expected: string | null): string {
  if (expected === "pr-green") return "check the worker's pane and either fm-send a nudge or report why validation runs have not reached a green PR with a corrected --next";
  if (expected) return `check the worker's pane and either fm-send a nudge or reply with a corrected --next for ${expected}`;
  return "check the worker's pane and either fm-send a nudge or reply with a corrected --next";
}

function openStall(db: StateDatabase, issue: string): DomainEvent | null {
  return db.listEvents(["captured", "classified", "waiting-for-core"])
    .find((event) => event.issue === issue && event.token === "stalled") ?? null;
}

function resolveStall(db: StateDatabase, eventId: string | null, note: string, at: string): void {
  if (!eventId) return;
  const event = db.event(eventId);
  if (event?.disposition === "waiting-for-core") db.setDisposition(eventId, "handled-by-service", note, at);
}

function resolveOpenHeartbeat(db: StateDatabase, issue: string, note: string, at: string): void {
  const event = openStall(db, issue);
  if (!event) return;
  try {
    if ((JSON.parse(event.raw_ref) as { kind?: string }).kind === "heartbeat") {
      db.setDisposition(event.id, "handled-by-service", note, at);
    }
  } catch { /* a malformed event remains visible for manual handling */ }
}

function emitStall(db: StateDatabase, options: {
  team: string;
  issue: string;
  reasonKey: string;
  note: string;
  required: string;
  kind: "promise" | "heartbeat";
  expected?: string;
  deadlineAt?: string;
  progress: Progress | null;
  at: string;
}): string | null {
  const prior = openStall(db, options.issue);
  if (prior) {
    let priorReason = "";
    try { priorReason = (JSON.parse(prior.raw_ref) as { reason_key?: string }).reason_key ?? ""; } catch { /* different reason */ }
    if (priorReason === options.reasonKey) return null;
    db.setDisposition(prior.id, "ignored", "superseded by a changed stall reason", options.at);
  }
  const id = `linear:${sha256(`stalled:${options.issue}:${options.reasonKey}`)}`;
  const note = `${options.note} - run fm-linear inbox show ${id}`;
  const captured = db.capture({
    id,
    team: options.team,
    issue: options.issue,
    type: "stalled",
    token: "stalled",
    author: "fm-linear",
    body_sha: null,
    created_at: options.at,
    captured_at: options.at,
    disposition: "waiting-for-core",
    note,
    raw_ref: JSON.stringify({
      kind: options.kind,
      reason_key: options.reasonKey,
      expected: options.expected ?? null,
      deadline_at: options.deadlineAt ?? null,
      last_progress: options.progress,
      required: options.required,
    }),
  });
  return captured ? id : null;
}

export function reconcileStalls(home: string, db: StateDatabase, config: WorkflowConfig, env: NodeJS.ProcessEnv = process.env): StallResult {
  const now = nowEpoch(env);
  const at = formatIso(now);
  let emitted = 0;
  let kept = 0;
  let overdue = 0;
  const promisedIssues = new Set<string>();
  for (const promise of db.promises(undefined, ["superseded"])) {
    resolveStall(db, promise.stalled_event_id, "promise superseded by a newer commitment", at);
  }
  for (const promise of db.promises(undefined, ["open", "overdue"])) {
    promisedIssues.add(promise.issue);
    const observed = matchingObservation(db, promise);
    if (observed) {
      db.keepPromise(promise.id, observed.id);
      resolveStall(db, promise.stalled_event_id, `promise kept by ${observed.detail}`, at);
      kept += 1;
      continue;
    }
    const deadline = parseIso(promise.deadline_at);
    const created = parseIso(promise.created_at);
    if (deadline === null || created === null || now <= deadline) continue;
    const interval = Math.max(1, deadline - created);
    const multiple = Math.floor((now - deadline) / interval) + 1;
    const progress = lastProgress(db, promise.issue);
    const team = promise.issue.split("-")[0] ?? "SYSTEM";
    const last = progress ? `${clock(progress.at)}: ${progress.detail}` : "none";
    const note = `stalled ${promise.issue}: promised ${promise.expected_event} by ${clock(promise.deadline_at)}, not observed (last progress ${last})`;
    const eventId = emitStall(db, {
      team, issue: promise.issue, reasonKey: `promise:${promise.id}:${multiple}`, note,
      required: requiredFor(promise.expected_event), kind: "promise", expected: promise.expected_event,
      deadlineAt: promise.deadline_at, progress, at,
    });
    if (eventId) emitted += 1;
    const stalledEventId = eventId ?? promise.stalled_event_id;
    if (stalledEventId) db.markPromiseOverdue(promise.id, stalledEventId);
    overdue += 1;
  }

  const progressDeadlines = config.deadlines?.progress ?? DEFAULT_PROGRESS_DEADLINES;
  for (const snapshot of db.latestSnapshots()) {
    if (promisedIssues.has(snapshot.issue)) continue;
    const team = config.teams.find((item) => item.key === snapshot.issue.split("-")[0]);
    if (!team || !firstmateOwnedStatuses(team).has(snapshot.state)) {
      resolveOpenHeartbeat(db, snapshot.issue, "issue is no longer Firstmate-owned", at);
      continue;
    }
    const deadline = progressDeadlines[snapshot.state];
    if (!deadline) continue;
    if (busy(home, db, snapshot.issue)) {
      resolveOpenHeartbeat(db, snapshot.issue, "primary worker is busy", at);
      continue;
    }
    const progress = lastProgress(db, snapshot.issue);
    const progressAt = parseIso(progress?.at ?? snapshot.observed_at);
    if (progressAt === null) continue;
    if (now - progressAt <= deadline) {
      resolveOpenHeartbeat(db, snapshot.issue, "issue progress resumed", at);
      continue;
    }
    const age = now - progressAt;
    const multiple = Math.floor(age / deadline);
    const note = `stalled ${snapshot.issue}: ${snapshot.state} ${Math.floor(age / 60)}m with no progress and no busy worker (last: ${progress?.detail ?? "board state"} ${clock(progress?.at ?? snapshot.observed_at)})`;
    if (emitStall(db, {
      team: team.key, issue: snapshot.issue, reasonKey: `heartbeat:${snapshot.state}:${progress?.id ?? snapshot.observed_at}:${multiple}`,
      note, required: requiredFor(null), kind: "heartbeat", progress, at,
    })) emitted += 1;
  }
  return { emitted, kept, overdue };
}

export function issueStatus(home: string, db: StateDatabase, issue: string): string {
  const progress = lastProgress(db, issue);
  const promises = db.promises(issue, ["open", "overdue"]);
  const tasks = db.taskLinks(issue, true).map((link) => {
    return `${link.task} (${link.role}, ${taskBusyState(home, link.task)})`;
  });
  return [
    `issue ${issue}`,
    `last progress: ${progress ? `${progress.at} ${progress.detail}` : "none"}`,
    `promises: ${promises.length ? promises.map((item) => `${item.expected_event} ${item.state} by ${item.deadline_at}`).join("; ") : "none"}`,
    `tasks: ${tasks.length ? tasks.join("; ") : "none"}`,
  ].join("\n");
}
