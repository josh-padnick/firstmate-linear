import { FmError } from "../support/errors";
import { checkBrief, updateBrief } from "./briefs";
import { requireCapability, testFirstmateInstallation } from "./compatibility";
import { getFirstmateFleet } from "./fleet";
import { FleetReader } from "./fleet-reader";
import { FleetStore } from "./fleet-store";
import type { FleetReadOptions } from "./fleet-types";
import { getFirstmateInstallation } from "./installation";
import { receiveMessage, sendMessage } from "./messages";
import { RoutedHomeReader } from "./routed-task";
import { AdapterStore } from "./store";
import { readFirstmateTask } from "./task";
import {
  type Capability,
  type FirstmateBriefUpdateReceipt,
  type FirstmateBriefUpdateRequest,
  type FirstmateTaskAttemptRef,
  type FirstmateTaskRef,
  type FirstmateTaskSnapshot,
  type MessageToFirstmate,
  TaskRef,
} from "./types";

export { getFirstmateInstallation };
export class FirstmateAdapter {
  private withSuggestions(snapshot: FirstmateTaskSnapshot): FirstmateTaskSnapshot {
    if (snapshot.presence === "found") return snapshot;
    const id = snapshot.task.taskId;
    const nearby =
      new FleetStore(this.store, this.installation.homeId)
        .observations()
        .find((h) => h.owner.homeId === snapshot.task.homeId)
        ?.work.filter(
          (w) =>
            w.task.taskId !== id &&
            (id === `${w.task.taskId}.` || (id.length >= 8 && w.task.taskId.startsWith(id))),
        )
        .slice(0, 3)
        .map((w) => w.task) ?? [];
    return nearby.length ? { ...snapshot, suggestions: nearby } : snapshot;
  }
  private constructor(
    readonly installation: Awaited<ReturnType<typeof getFirstmateInstallation>>,
    readonly store: AdapterStore,
  ) {}
  static async open(options: { home: string; codeRoot: string; database: string }) {
    const installation = await getFirstmateInstallation(options);
    return new FirstmateAdapter(installation, new AdapterStore(options.database));
  }
  testFirstmateInstallation(capabilities?: Capability[]) {
    return testFirstmateInstallation(this.installation, this.store, capabilities);
  }
  async getFirstmateFleet(options?: FleetReadOptions) {
    const installation = await requireCapability(this.installation, this.store, "fleet");
    let allowRemote = true;
    try {
      await requireCapability(installation, this.store, "routed-reads");
    } catch (error) {
      if (!(error instanceof FmError) || error.code !== "firstmate.capability_held") throw error;
      allowRemote = false;
    }
    return getFirstmateFleet(
      installation,
      this.store,
      options,
      new FleetReader(installation, undefined, allowRemote),
    );
  }
  async getFirstmateTask(input: FirstmateTaskRef): Promise<FirstmateTaskSnapshot> {
    const task = TaskRef.parse(input);
    if (task.homeId !== this.installation.homeId) {
      await requireCapability(this.installation, this.store, "routed-reads");
      try {
        return this.withSuggestions(
          await new RoutedHomeReader(this.installation, this.store).readTask(task),
        );
      } catch (error) {
        if (
          !(error instanceof FmError) ||
          ![
            "firstmate.command_failed",
            "firstmate.command_timed_out",
            "firstmate.command_output_limit",
            "firstmate.contract_failed",
          ].includes(error.code)
        )
          throw error;
        const old = new FleetStore(this.store, this.installation.homeId)
          .observations()
          .find((h) => h.owner.homeId === task.homeId)
          ?.work.find((w) => w.task.taskId === task.taskId);
        return {
          task,
          presence: "not-verified",
          attempt: null,
          observedAt: new Date().toISOString(),
          activity: { state: "unknown", source: "none" },
          dependencies: { status: "unknown", reason: "no-verified-contract" },
          briefRevision: null,
          readIssue: { code: error.code, nextAction: error.nextAction },
          ...(old
            ? {
                lastKnown: {
                  activity: old.activity,
                  observedAt: old.observedAt,
                  attempt: old.attempt,
                },
              }
            : {}),
        };
      }
    }
    const installation = await requireCapability(this.installation, this.store, "task-state");
    return this.withSuggestions(await readFirstmateTask(installation, task));
  }
  async updateFirstmateBrief(request: FirstmateBriefUpdateRequest) {
    await requireCapability(this.installation, this.store, "briefs");
    return updateBrief(this.installation, this.store, request);
  }
  async checkFirstmateBrief(
    receipt: FirstmateBriefUpdateReceipt,
    attempt: FirstmateTaskAttemptRef,
  ) {
    if (attempt.task.homeId !== this.installation.homeId) {
      await requireCapability(this.installation, this.store, "routed-reads");
      return new RoutedHomeReader(this.installation, this.store).checkBrief(receipt, attempt);
    }
    await requireCapability(this.installation, this.store, "briefs");
    return checkBrief(this.installation, receipt, attempt);
  }
  async sendFirstmateMessage(message: MessageToFirstmate) {
    await requireCapability(this.installation, this.store, "messages");
    return sendMessage(this.installation, this.store, message);
  }
  receiveFirstmateMessage(input: unknown) {
    return receiveMessage(this.installation, this.store, input);
  }
  close() {
    this.store.close();
  }
}
