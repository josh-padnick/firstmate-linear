import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowConfig } from "../config/schema.ts";
import { type EventDisposition, type NewJob, observationBelongsToTaskLink, type StateDatabase, type TaskLink } from "../db/database.ts";
import type { ClassifiableEvent } from "../classify/classify.ts";

export type RelayDecision = {
  disposition: EventDisposition;
  job: NewJob | null;
  note: string;
};

function activeKeys(db: StateDatabase, link: TaskLink): string[] {
  const keys = new Set<string>();
  for (const event of db.observations(link.issue)) {
    if (!observationBelongsToTaskLink(event, link)) continue;
    if (event.verb === "needs-decision" && event.key) keys.add(event.key);
    if (event.verb === "resolved" && event.key) keys.delete(event.key);
  }
  return [...keys];
}

function delegated(metaPath: string): boolean {
  try {
    return readFileSync(metaPath, "utf8").split(/\r?\n/).some((line) => /^delegate=\S+/.test(line.trim()));
  } catch { return false; }
}

export function decideRelay(options: {
  event: ClassifiableEvent;
  db: StateDatabase;
  config: WorkflowConfig;
  home: string;
}): RelayDecision {
  const { event, db, config, home } = options;
  if (event.type !== "comment" || event.author !== config.captain.display_name) {
    return { disposition: "waiting-for-core", job: null, note: "relay requires a captain comment" };
  }
  const primary = db.taskLinks(event.issue, true).filter((link) => link.role === "primary");
  if (primary.length !== 1) {
    return { disposition: "waiting-for-core", job: null, note: `relay needs exactly one live primary task; found ${primary.length}` };
  }
  const task = primary[0]!;
  const metaPath = join(home, "state", `${task.task}.meta`);
  if (!existsSync(metaPath)) {
    return { disposition: "waiting-for-core", job: null, note: `relay task ${task.task} has no live .meta` };
  }
  if (delegated(metaPath)) {
    return { disposition: "waiting-for-core", job: null, note: `relay task ${task.task} is delegated` };
  }
  const keys = activeKeys(db, task);
  const snapshot = db.latestSnapshot(event.issue);
  const team = config.teams.find((item) => item.key === event.team);
  const building = snapshot?.state === team?.statuses.building;
  if (keys.length > 1 || (keys.length === 0 && !building)) {
    return { disposition: "waiting-for-core", job: null, note: `relay precondition failed: open keys=${keys.length}, state=${snapshot?.state ?? "unknown"}` };
  }
  const job: NewJob = {
    key: `${event.id}:relay`, kind: "relay", target: event.issue,
    payload: { event_id: event.id, issue: event.issue, task: task.task, key: keys[0] ?? null },
  };
  if (config.features.relay === "on") {
    return { disposition: "classified", job, note: `relay queued for ${task.task}` };
  }
  return { disposition: "waiting-for-core", job: null, note: `relay ${config.features.relay}: would relay to ${task.task}` };
}
