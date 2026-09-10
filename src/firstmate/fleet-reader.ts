import { join } from "node:path";
import { type CommandResult, commandEnvironment, runCommand } from "../support/command";
import { FmError } from "../support/errors";
import { confinedFile, hash, readBounded } from "../support/files";
import { type FleetDocument, parseFleet } from "./fleet-schema";
import type { FirstmateHomeRoute } from "./fleet-types";
import type { FirstmateInstallation } from "./types";

export type FleetExecute = (
  home: string,
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<CommandResult>;

/** One bounded read boundary. No arbitrary shell commands, writes, or agent messages. */
export class FleetReader {
  reads = 0;
  readonly deadline = Date.now() + 60000;
  constructor(
    readonly installation: FirstmateInstallation,
    private execute: FleetExecute = (home, command, args, timeoutMs) =>
      runCommand("/bin/bash", [join(installation.codeRoot, "bin", command), ...args], {
        cwd: home,
        env: commandEnvironment(home, installation.codeRoot),
        timeoutMs,
        limit: 2 * 1024 * 1024,
        operation: "fleet-read",
      }),
    private allowRemote = true,
  ) {}
  async command(
    route: FirstmateHomeRoute,
    command: "fm-fleet-snapshot.sh" | "fm-crew-state.sh" | "fm-remote-file.sh",
    args: string[],
  ) {
    if (route.kind === "remote" && !this.allowRemote)
      throw new FmError(
        "firstmate.capability_held",
        "Routed reads have no passing compatibility check.",
        "not-attempted",
        "Run fm-linear test --capability routed-reads with the same required options.",
      );
    const remaining = this.deadline - Date.now();
    if (remaining <= 0)
      throw new FmError(
        "firstmate.command_timed_out",
        "The fleet read reached its 60-second budget.",
      );
    this.reads++;
    return route.kind === "remote"
      ? this.execute(
          this.installation.home,
          "fm-on.sh",
          [route.owner.secondmateId as string, command, ...args],
          Math.min(15000, remaining),
        )
      : this.execute(route.home, command, args, Math.min(30000, remaining));
  }
  async snapshot(route: FirstmateHomeRoute): Promise<FleetDocument> {
    const result = await this.command(route, "fm-fleet-snapshot.sh", ["--json"]);
    if (result.code !== 0)
      throw new FmError(
        "firstmate.command_failed",
        "Firstmate could not read this home's fleet. Previous observations remain last-known.",
      );
    const doc = parseFleet(result.stdout);
    if (doc.fm_home !== route.home || doc.roots.fm_root !== route.codeRoot)
      throw new FmError(
        "firstmate.route_changed",
        "The snapshot came from a different Firstmate home or source checkout.",
      );
    return doc;
  }
  async registryRevision(): Promise<string | null> {
    const path = await confinedFile(this.installation.home, ["data", "secondmates.md"], true);
    return path ? hash(await readBounded(path)) : null;
  }
}
