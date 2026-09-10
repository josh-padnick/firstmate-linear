import { FmError } from "../support/errors";
import { checkBrief, updateBrief } from "./briefs";
import { requireCapability, testFirstmateInstallation } from "./compatibility";
import { getFirstmateInstallation } from "./installation";
import { receiveMessage, sendMessage } from "./messages";
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
    return readFirstmateTask(installation, task);
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
