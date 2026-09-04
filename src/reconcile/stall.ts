import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PROGRESS_DEADLINES, type TeamConfig, type WorkflowConfig } from "../config/schema.ts";
import { type DomainEvent, type Observation, observationBelongsToTaskLink, type PromiseRecord, type PromiseSourceWatermarks, type StateDatabase, type TaskLink } from "../db/database.ts";
import { sha256 } from "../hash.ts";
import { sidecarGeneration } from "../mirror/generation.ts";
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

function wasPrimaryTaskAt(db: StateDatabase, observation: Observation): boolean {
  return db.taskLinks(observation.issue).some((link) => link.role === "primary"
    && observationBelongsToTaskLink(observation, link));
}

function sourceWatermarks(promise: PromiseRecord): PromiseSourceWatermarks | null | undefined {
  if (!promise.source_watermarks) return undefined;
  try { return JSON.parse(promise.source_watermarks) as PromiseSourceWatermarks; }
  catch { return null; }
}

function newLifecycleAfterPromise(db: StateDatabase, promise: PromiseRecord, lifecycle: string): boolean {
  const link = db.taskLinks(promise.issue).find((item) => item.lifecycle_id === lifecycle);
  return Boolean(link && atOrAfter(link.spawned_at, promise.created_at));
}

function statusBeyondSourceWatermark(db: StateDatabase, promise: PromiseRecord, observation: Observation): boolean {
  const watermarks = sourceWatermarks(promise);
  if (watermarks === undefined) return true;
  if (!watermarks) return false;
  const lifecycle = observation.task_lifecycle_id;
  if (!lifecycle) return false;
  const entry = watermarks[lifecycle];
  if (!entry) return newLifecycleAfterPromise(db, promise, lifecycle);
  const watermark = entry.status ?? ("offset" in entry ? entry as unknown as { identity: string | null; offset: number } : undefined);
  if (!watermark) return true;
  if (!observation.source_identity || observation.source_offset === null || observation.source_offset === undefined) return false;
  return observation.source_identity !== watermark.identity || observation.source_offset >= watermark.offset;
}

function matchingPrObservation(db: StateDatabase, promise: PromiseRecord, observations: Observation[]): Observation | null {
  const watermarks = sourceWatermarks(promise);
  const baselines = new Map<string, string | null>();
  const advanced = new Set<string>();
  for (const observation of observations) {
    if (observation.source !== "pr" || !observation.task || !wasPrimaryTaskAt(db, observation)) continue;
    if (watermarks === undefined) {
      if (observation.verb === promise.expected_event) return observation;
      continue;
    }
    if (!watermarks || !observation.task_lifecycle_id || !observation.source_identity) continue;
    const lifecycle = observation.task_lifecycle_id;
    const entry = watermarks[lifecycle];
    if (!entry) {
      if (newLifecycleAfterPromise(db, promise, lifecycle) && observation.verb === promise.expected_event) return observation;
      continue;
    }
    if (!entry.pr) {
      if (observation.verb === promise.expected_event) return observation;
      continue;
    }
    if (promise.expected_event === "pr-reported") {
      if (observation.verb === "pr-reported" && (entry.pr.reported === null || observation.source_identity !== entry.pr.reported)) return observation;
      continue;
    }
    if (observation.verb === "pr-reported") continue;
    if (!baselines.has(lifecycle)) {
      if (entry.pr.stateKnown) baselines.set(lifecycle, entry.pr.state);
      else {
        baselines.set(lifecycle, observation.source_identity);
        continue;
      }
    }
    if (observation.source_identity !== baselines.get(lifecycle)) {
      baselines.set(lifecycle, observation.source_identity);
      advanced.add(lifecycle);
    }
    if (advanced.has(lifecycle) && observation.verb === promise.expected_event) return observation;
  }
  return null;
}

function matchingObservation(db: StateDatabase, promise: PromiseRecord): Progress | null {
  const expected = promise.expected_event;
  const watermarks = sourceWatermarks(promise);
  const boundary = watermarks?.__boundary__;
  const observations = watermarks === null
    ? []
    : boundary
      ? db.observationsAfterRowid(boundary.observation_rowid ?? 0)
        .map((item) => item.observation)
        .filter((item) => item.issue === promise.issue && atOrAfter(item.observed_at, promise.created_at))
      : promise.source_watermarks !== null
        ? db.observations(promise.issue).filter((item) => atOrAfter(item.observed_at, promise.created_at))
        : db.observations(promise.issue, promise.created_at);
  if (expected.startsWith("status:")) {
    const verb = expected.slice("status:".length);
    const found = observations.find((item) => item.source === "status"
      && item.verb === verb
      && item.task
      && wasPrimaryTaskAt(db, item)
      && statusBeyondSourceWatermark(db, promise, item));
    return found ? { id: found.id, kind: "status", at: found.observed_at, detail: `status ${verb}` } : null;
  }
  if (expected.startsWith("board:")) {
    const state = expected.slice("board:".length);
    const unambiguousAfter = boundary?.unambiguous_after;
    const transition = observations.find((item) => item.source === "linear"
      && item.verb === "board-transition"
      && item.key === state
      && (!unambiguousAfter || atOrAfter(item.observed_at, unambiguousAfter)));
    return transition ? { id: transition.id, kind: "board", at: transition.observed_at, detail: `board ${state}` } : null;
  }
  if (["pr-reported", "pr-green", "pr-merged"].includes(expected)) {
    const found = matchingPrObservation(db, promise, observations);
    return found ? { id: found.id, kind: "pr", at: found.observed_at, detail: expected } : null;
  }
  if (expected === "comment") {
    const found = observations.find((item) => item.verb === "firstmate-comment" && item.key !== promise.reply_comment_id);
    return found ? { id: found.id, kind: "comment", at: found.observed_at, detail: "firstmate comment" } : null;
  }
  if (expected === "dispatch") {
    const priorLifecycles = boundary?.primary_lifecycle_ids;
    const found = db.taskLinks(promise.issue).find((item) => item.role === "primary"
      && (priorLifecycles ? !priorLifecycles.includes(item.lifecycle_id) : atOrAfter(item.spawned_at, promise.created_at)));
    return found ? { id: `dispatch:${found.task}:${found.spawned_at}`, kind: "dispatch", at: found.spawned_at, detail: `dispatch ${found.task}` } : null;
  }
  return null;
}

export function lastProgress(db: StateDatabase, issue: string): Progress | null {
  let latest: Progress | null = null;
  for (const item of db.observations(issue)) {
    const taskProgress = item.task
      && (item.source === "status" || item.source === "pr")
      && wasPrimaryTaskAt(db, item);
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
  for (const link of db.taskLinks(issue).filter((item) => item.role === "primary")) {
    latest = later(latest, { id: `dispatch:${link.task}:${link.spawned_at}`, kind: "dispatch", at: link.spawned_at, detail: link.task });
  }
  return latest;
}

function taskBusyState(home: string, link: TaskLink): "busy" | "not-busy" {
  const path = join(home, "state", `${link.task}.busy-state`);
  if (!existsSync(path)) return "not-busy";
  try {
    const generation = sidecarGeneration(path, "gen");
    if (generation && generation === link.blocked_busy_generation) return "not-busy";
    const text = readFileSync(path, "utf8");
    const match = /^v1 gen=\S+ seq=\d+ state=(busy|idle) source=\S+ event=\S+ ts=\d+\n?$/.exec(text);
    return match?.[1] === "busy" ? "busy" : "not-busy";
  } catch { return "not-busy"; }
}

function busy(home: string, db: StateDatabase, issue: string): boolean {
  for (const link of db.taskLinks(issue, true).filter((item) => item.role === "primary")) {
    if (taskBusyState(home, link) === "busy") return true;
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
  seriesKey: string;
  stalledAt: string;
  note: string;
  required: string;
  kind: "promise" | "heartbeat";
  expected?: string;
  deadlineAt?: string;
  progress: Progress | null;
  at: string;
}): { id: string; captured: boolean } {
  return db.transaction(() => {
    const id = `linear:${sha256(`stalled:${options.issue}:${options.reasonKey}`)}`;
    const prior = openStall(db, options.issue);
    if (prior) {
      let priorReason = "";
      try { priorReason = (JSON.parse(prior.raw_ref) as { reason_key?: string }).reason_key ?? ""; } catch { /* different reason */ }
      if (priorReason === options.reasonKey) return { id, captured: false };
      db.setDisposition(prior.id, "ignored", "superseded by a changed stall reason", options.at);
    }
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
        escalation_key: `stall:${sha256(`${options.issue}:${options.seriesKey}`)}`,
        stalled_at: options.stalledAt,
        expected: options.expected ?? null,
        deadline_at: options.deadlineAt ?? null,
        last_progress: options.progress,
        required: options.required,
      }),
    });
    if (prior && prior.id !== id) db.rebindWaitingEventJobs(prior.id, id);
    return { id, captured };
  });
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
    if (db.latestSnapshot(promise.issue)?.managed === false) {
      resolveStall(db, promise.stalled_event_id, "issue is no longer managed", at);
      db.cancelPromise(promise.id);
      continue;
    }
    promisedIssues.add(promise.issue);
    resolveOpenHeartbeat(db, promise.issue, "promise commitment established", at);
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
    const emission = emitStall(db, {
      team, issue: promise.issue, reasonKey: `promise:${promise.id}:${multiple}`,
      seriesKey: `promise:${promise.id}`, stalledAt: promise.deadline_at, note,
      required: requiredFor(promise.expected_event), kind: "promise", expected: promise.expected_event,
      deadlineAt: promise.deadline_at, progress, at,
    });
    if (emission.captured) emitted += 1;
    db.markPromiseOverdue(promise.id, emission.id);
    overdue += 1;
  }

  const progressDeadlines = config.deadlines?.progress ?? DEFAULT_PROGRESS_DEADLINES;
  for (const snapshot of db.latestSnapshots()) {
    if (!snapshot.managed) {
      resolveOpenHeartbeat(db, snapshot.issue, "issue is no longer managed", at);
      continue;
    }
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
      seriesKey: `heartbeat:${snapshot.state}:${progress?.id ?? snapshot.observed_at}`,
      stalledAt: formatIso(progressAt + deadline),
      note, required: requiredFor(null), kind: "heartbeat", progress, at,
    }).captured) emitted += 1;
  }
  return { emitted, kept, overdue };
}

export function issueStatus(home: string, db: StateDatabase, issue: string): string {
  const progress = lastProgress(db, issue);
  const promises = db.promises(issue, ["open", "overdue"]);
  const tasks = db.taskLinks(issue, true).map((link) => {
    return `${link.task} (${link.role}, ${taskBusyState(home, link)})`;
  });
  return [
    `issue ${issue}`,
    `last progress: ${progress ? `${progress.at} ${progress.detail}` : "none"}`,
    `promises: ${promises.length ? promises.map((item) => `${item.expected_event} ${item.state} by ${item.deadline_at}`).join("; ") : "none"}`,
    `tasks: ${tasks.length ? tasks.join("; ") : "none"}`,
  ].join("\n");
}
