import { commandEnvironment, runCommand } from "../support/command";
import { FmError } from "../support/errors";
import { confinedFile, hash, readBounded } from "../support/files";
import { checkBrief, updateBrief } from "./briefs";
import { requireCapability, testFirstmateInstallation } from "./compatibility";
import { getFirstmateInstallation, metadata } from "./installation";
import { receiveMessage, sendMessage } from "./messages";
import { AdapterStore } from "./store";
import {
  AttemptId,
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
  async getFirstmateTask(input: FirstmateTaskRef): Promise<FirstmateTaskSnapshot> {
    const task = TaskRef.parse(input);
    if (task.homeId !== this.installation.homeId)
      throw new FmError("firstmate.scope_mismatch", "The task belongs to another home.");
    const installation = await requireCapability(this.installation, this.store, "task-state");
    const before = await metadata(installation.home, task.taskId);
    const result = await runCommand(
      "/bin/bash",
      [`${installation.codeRoot}/bin/fm-crew-state.sh`, task.taskId],
      { cwd: installation.home, env: commandEnvironment(installation.home, installation.codeRoot) },
    );
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
      attempt: stable && generation.success ? { task, attemptId: generation.data } : null,
      observedAt: new Date().toISOString(),
      activity: stable
        ? { state: match[1] ?? "unknown", source: match[2] ?? "none" }
        : { state: "unknown", source: "none" },
      dependencies: { status: "unknown", reason: "no-verified-contract" },
      briefRevision: path ? hash(await readBounded(path)) : null,
    };
  }
  async updateFirstmateBrief(request: FirstmateBriefUpdateRequest) {
    await requireCapability(this.installation, this.store, "briefs");
    return updateBrief(this.installation, this.store, request);
  }
  async checkFirstmateBrief(
    receipt: FirstmateBriefUpdateReceipt,
    attempt: FirstmateTaskAttemptRef,
  ) {
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
