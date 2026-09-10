import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commandEnvironment } from "../support/command";
import { getFirstmateInstallation } from "./installation";
import type { IsolatedFirstmate } from "./isolation";
import { readFirstmateTask } from "./task";
import { type FirstmateTaskSnapshot, TaskId } from "./types";

export class TaskStateProbeError extends Error {}

/** Exercise local Claude lifecycle records with a fake, readable tmux endpoint; no agent runs. */
export async function taskStateProbe(fixture: IsolatedFirstmate) {
  const installation = await getFirstmateInstallation({
    home: fixture.home,
    codeRoot: fixture.codeRoot,
  });
  const task = { homeId: installation.homeId, taskId: TaskId.parse("state-probe") };
  const state = join(fixture.home, "state");
  const worktree = join(fixture.home, "state-probe-worktree");
  const tools = join(fixture.home, "state-probe-tools");
  await mkdir(state, { recursive: true });
  await mkdir(worktree);
  await mkdir(tools);
  await writeFile(
    join(tools, "tmux"),
    '#!/bin/sh\nif [ "$1" = display-message ]; then printf "%s\\n" "%1"; exit 0; fi\nexit 97\n',
    { mode: 0o700 },
  );
  const execute = (command: string, args: string[]) =>
    fixture.run(command, args, {
      PATH: `${tools}:${join(fixture.root, "tools")}:${commandEnvironment(fixture.home, fixture.codeRoot, { isolated: true }).PATH}`,
    });
  const observations: { check: string; snapshot: FirstmateTaskSnapshot }[] = [];
  async function check(
    label: string,
    expectedState: string,
    expectedSource: string,
    attempt: string | null,
  ) {
    const mismatch = () =>
      new TaskStateProbeError(
        `Task-state check '${label}' did not establish ${expectedState} from ${expectedSource} with the expected task and attempt.`,
      );
    let snapshot: FirstmateTaskSnapshot;
    try {
      snapshot = await readFirstmateTask(installation, task, execute);
    } catch {
      throw mismatch();
    }
    if (
      snapshot.task.homeId !== task.homeId ||
      snapshot.task.taskId !== task.taskId ||
      snapshot.activity.state !== expectedState ||
      snapshot.activity.source !== expectedSource ||
      (snapshot.attempt?.attemptId ?? null) !== attempt ||
      (snapshot.attempt &&
        (snapshot.attempt.task.homeId !== task.homeId ||
          snapshot.attempt.task.taskId !== task.taskId))
    )
      throw mismatch();
    observations.push({ check: label, snapshot });
  }
  async function event(args: string[]) {
    const result = await execute("/bin/bash", [
      join(fixture.codeRoot, "bin/fm-busy-event.sh"),
      ...args,
    ]);
    if (result.code !== 0)
      throw new TaskStateProbeError(
        "Task-state fixture could not record a lifecycle event using fm-busy-event.sh.",
      );
    return result.stdout.trim();
  }
  async function metadata(attempt: string) {
    await writeFile(
      join(state, `${task.taskId}.meta`),
      `worktree=${worktree}\nkind=scout\nharness=claude\nbackend=tmux\nwindow=fm:fm-state-probe\nspawn_gen=${attempt}\n`,
    );
  }
  await check("missing task", "unknown", "none", null);
  await metadata("attempt-a");
  const generation = await event(["arm", state, task.taskId]);
  await check("known working task", "working", "pane", "attempt-a");
  const busyPath = join(state, `${task.taskId}.busy-state`);
  const oldBusy = await readFile(busyPath);
  await event([
    "apply",
    state,
    task.taskId,
    "idle",
    "--gen",
    generation,
    "--source",
    "claude-hook",
    "--event",
    "stop",
  ]);
  await writeFile(join(state, `${task.taskId}.status`), "needs-decision: choose the next action\n");
  await check("task awaits a decision", "parked", "status-log", "attempt-a");
  await metadata("attempt-b");
  await event(["arm", state, task.taskId]);
  await writeFile(busyPath, oldBusy);
  await check("previous incarnation evidence", "unknown", "pane", "attempt-b");
  await rm(busyPath);
  await check("missing lifecycle evidence", "unknown", "pane", "attempt-b");
  await rm(join(state, `${task.taskId}.meta`));
  await check("removed task metadata", "unknown", "none", null);
  return observations;
}
