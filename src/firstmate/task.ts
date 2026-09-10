import { type CommandResult, commandEnvironment, runCommand } from "../support/command";
import { FmError } from "../support/errors";
import { confinedFile, hash, readBounded } from "../support/files";
import { metadata } from "./installation";
import {
  AttemptId,
  type FirstmateInstallation,
  type FirstmateTaskRef,
  type FirstmateTaskSnapshot,
} from "./types";

export async function readFirstmateTask(
  installation: FirstmateInstallation,
  task: FirstmateTaskRef,
  execute: (command: string, args: string[]) => Promise<CommandResult> = (command, args) =>
    runCommand(command, args, {
      cwd: installation.home,
      env: commandEnvironment(installation.home, installation.codeRoot),
      operation: "task-state",
    }),
): Promise<FirstmateTaskSnapshot> {
  const before = await metadata(installation.home, task.taskId);
  const result = await execute("/bin/bash", [
    `${installation.codeRoot}/bin/fm-crew-state.sh`,
    task.taskId,
  ]);
  const match = /^state: ([a-z-]+) · source: ([a-z0-9-]+)(?: · [^\n]*)?\n?$/.exec(result.stdout);
  if (result.code !== 0 || !match)
    throw new FmError(
      "firstmate.contract_failed",
      "The worker-state command returned an unsupported result.",
    );
  const after = await metadata(installation.home, task.taskId);
  const stable = before?.spawn_gen === after?.spawn_gen;
  const generation = AttemptId.safeParse(after?.spawn_gen);
  const path = await confinedFile(installation.home, ["data", task.taskId, "brief.md"], true);
  return {
    task,
    presence: after || path ? "found" : "not-verified",
    attempt: stable && generation.success ? { task, attemptId: generation.data } : null,
    observedAt: new Date().toISOString(),
    activity: stable
      ? { state: match[1] ?? "unknown", source: match[2] ?? "none" }
      : { state: "unknown", source: "none" },
    dependencies: { status: "unknown", reason: "no-verified-contract" },
    briefRevision: path ? hash(await readBounded(path)) : null,
  };
}
