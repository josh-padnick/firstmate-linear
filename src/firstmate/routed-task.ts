import { FmError } from "../support/errors";
import { hash } from "../support/files";
import { checkBrief } from "./briefs";
import { FleetReader } from "./fleet-reader";
import { FleetStore } from "./fleet-store";
import type { FirstmateHomeRoute } from "./fleet-types";
import type { AdapterStore } from "./store";
import { readFirstmateTask } from "./task";
import {
  AttemptId,
  AttemptRef,
  BriefReceipt,
  type FirstmateBriefCheck,
  type FirstmateBriefUpdateReceipt,
  type FirstmateInstallation,
  type FirstmateTaskAttemptRef,
  type FirstmateTaskRef,
  type FirstmateTaskSnapshot,
  TaskRef,
} from "./types";

function generation(text: string): string | null {
  const lines = text.split("\n").filter((l) => l.startsWith("spawn_gen="));
  if (lines.length !== 1) return null;
  const parsed = AttemptId.safeParse(lines[0]?.slice("spawn_gen=".length));
  return parsed.success ? parsed.data : null;
}

/** Owns saved-route lookup, verification, and detailed reads for one primary installation. */
export class RoutedHomeReader {
  constructor(
    private installation: FirstmateInstallation,
    private store: AdapterStore,
    private reader?: FleetReader,
  ) {}

  private async read<T>(
    homeId: FirstmateTaskRef["homeId"],
    operation: (route: FirstmateHomeRoute, reader: FleetReader) => Promise<T>,
    invalidated: () => T,
  ): Promise<T> {
    const reader = this.reader ?? new FleetReader(this.installation);
    const persistence = new FleetStore(this.store, this.installation.homeId);
    const route = persistence.routes().find((r) => r.owner.homeId === homeId);
    if (!route)
      throw new FmError(
        "firstmate.scope_mismatch",
        "The task's owning home has not been discovered through this primary.",
      );
    const observation = persistence.observations().find((h) => h.owner.homeId === homeId);
    if (observation?.coverage === "held")
      throw new FmError(
        "firstmate.route_changed",
        "This task's owning home is held because its registered route changed.",
      );
    const expected = this.store.get<{ revision: string | null }>(
      this.installation.homeId,
      "fleet",
      "registry-revision",
    );
    const revision = await reader.registryRevision();
    if (!expected?.revision || expected.revision !== revision)
      throw new FmError(
        "firstmate.route_changed",
        "The registered routes have not been checked for this read.",
        "not-attempted",
        "Run fm-linear fleet with the same required options before inspecting this secondmate.",
      );
    const result = await operation(route, reader);
    return revision === (await reader.registryRevision()) ? result : invalidated();
  }

  async checkBrief(
    inputReceipt: FirstmateBriefUpdateReceipt,
    inputAttempt: FirstmateTaskAttemptRef,
  ): Promise<FirstmateBriefCheck> {
    const receipt = BriefReceipt.parse(inputReceipt);
    const attempt = AttemptRef.parse(inputAttempt);
    if (receipt.task.homeId !== attempt.task.homeId || receipt.task.taskId !== attempt.task.taskId)
      throw new FmError(
        "firstmate.scope_mismatch",
        "The instruction evidence must name the same task and owning home.",
      );
    const base = { attempt, observedAt: new Date().toISOString(), launchRevision: null };
    return this.read(
      attempt.task.homeId,
      async (route, reader) => {
        if (route.kind === "local") {
          return checkBrief(
            { ...this.installation, home: route.home, homeId: route.owner.homeId },
            receipt,
            attempt,
          );
        }
        const file = async (path: string) => {
          const result = await reader.command(route, "fm-remote-file.sh", ["get", path, "262144"]);
          return result.code === 0 ? result.stdout : null;
        };
        const before = await file(`state/${attempt.task.taskId}.meta`);
        if (before === null || generation(before) !== attempt.attemptId)
          return { ...base, status: "not-verified", reason: "attempt-changed" };
        const content = await file(`data/${attempt.task.taskId}/launch-brief.md`);
        if (content === null)
          return { ...base, status: "not-verified", reason: "launch-evidence-unavailable" };
        const after = await file(`state/${attempt.task.taskId}.meta`);
        if (after === null || generation(after) !== attempt.attemptId)
          return { ...base, status: "not-verified", reason: "attempt-changed" };
        const start = content.indexOf("<!-- fm-linear:instructions:start -->");
        const endMarker = "<!-- fm-linear:instructions:end -->";
        const end = content.indexOf(endMarker, start);
        const block =
          start >= 0 && end >= start ? `${content.slice(start, end + endMarker.length)}\n` : "";
        const included = hash(block) === receipt.instructionDigest;
        return {
          ...base,
          observedAt: new Date().toISOString(),
          launchRevision: hash(content),
          status: included ? "included" : "missing",
          reason: included ? "matched" : "instructions-absent",
        };
      },
      () => ({ ...base, status: "not-verified", reason: "attempt-changed" }),
    );
  }

  async readTask(task: FirstmateTaskRef): Promise<FirstmateTaskSnapshot> {
    task = TaskRef.parse(task);
    return this.read(
      task.homeId,
      async (route, reader) => {
        let result: FirstmateTaskSnapshot;
        if (route.kind === "local") {
          result = await readFirstmateTask(
            { ...this.installation, home: route.home, homeId: route.owner.homeId },
            task,
            (_command, args) => reader.command(route, "fm-crew-state.sh", args.slice(1)),
          );
        } else {
          const file = async (path: string) => {
            const response = await reader.command(route, "fm-remote-file.sh", [
              "get",
              path,
              "262144",
            ]);
            return response.code === 0 ? response.stdout : null;
          };
          // No generated command strings: fm-on accepts fixed script names and literal argv.
          const before = await file(`state/${task.taskId}.meta`);
          const state = await reader.command(route, "fm-crew-state.sh", [task.taskId]);
          const brief = await file(`data/${task.taskId}/brief.md`);
          const after = await file(`state/${task.taskId}.meta`);
          const match = /^state: ([a-z-]+) · source: ([a-z0-9-]+)(?: · [^\n]*)?\n?$/.exec(
            state.stdout,
          );
          if (state.code !== 0 || !match)
            throw new FmError(
              "firstmate.contract_failed",
              "The routed worker-state read could not be verified.",
            );
          const attempt = after === null ? null : generation(after);
          const stable =
            before !== null &&
            after !== null &&
            generation(before) !== null &&
            generation(before) === attempt;
          result = {
            task,
            presence: after !== null || brief !== null ? "found" : "not-verified",
            attempt: stable && attempt ? { task, attemptId: AttemptId.parse(attempt) } : null,
            observedAt: new Date().toISOString(),
            activity: stable
              ? { state: match[1] as string, source: match[2] as string }
              : { state: "unknown", source: "none" },
            dependencies: { status: "unknown", reason: "no-verified-contract" },
            briefRevision: brief === null ? null : hash(brief),
          };
        }
        return result;
      },
      () => {
        throw new FmError(
          "firstmate.route_changed",
          "The registered route changed during the task read; its result was discarded.",
        );
      },
    );
  }
}
