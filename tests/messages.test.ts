import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packet, pollRequest, receiveMessage, sendMessage } from "../src/firstmate/messages";
import { AdapterStore } from "../src/firstmate/store";
import {
  AttemptId,
  type FirstmateInstallation,
  HomeId,
  MessageToFirstmateSchema,
  TaskId,
} from "../src/firstmate/types";
import { hash } from "../src/support/files";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fm-message-")));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(join(home, "state"), { recursive: true });
  const installation: FirstmateInstallation = {
    homeId: HomeId.parse("home-one"),
    home,
    codeRoot: root,
    commit: null,
    fingerprint: hash("fixture"),
    platform: process.platform,
  };
  return { root, installation, database: join(root, "private", "state.sqlite") };
}
const refuseRegistration = async () => ({ code: 1, stdout: "", stderr: "PRIVATE_CHILD_OUTPUT" });
test("acceptance survives a failed registration and process reopen; host retries cannot cross-route", async () => {
  const f = await fixture();
  let store = new AdapterStore(f.database);
  const request = MessageToFirstmateSchema.parse({
    requestId: "req-123",
    destination: { kind: "home", homeId: f.installation.homeId },
    text: "Explain this task",
    context: "A useful description, without Linear identifiers.",
  });
  try {
    await expect(
      sendMessage(f.installation, store, request, refuseRegistration),
    ).rejects.toMatchObject({ effect: "unknown" });
    store.close();
    store = new AdapterStore(f.database, { existing: true });
    const output = pollRequest(store, f.installation.homeId, request.requestId, "host-1");
    expect(output.output).toBe(packet(request));
    expect(pollRequest(store, f.installation.homeId, request.requestId, "host-1")).toEqual(output);
    expect(() => pollRequest(store, f.installation.homeId, request.requestId, "host-2")).toThrow();
    await expect(
      sendMessage(f.installation, store, { ...request, text: "Different" }, refuseRegistration),
    ).rejects.toMatchObject({ code: "firstmate.conflict" });
    expect(store.get(f.installation.homeId, "incoming", "answer")).toBeNull();
  } finally {
    store.close();
  }
});
test("responses correlate durably, preserve follow-ups, reject unknown IDs and qualify stale attempts", async () => {
  const f = await fixture();
  let store = new AdapterStore(f.database);
  const task = { homeId: f.installation.homeId, taskId: TaskId.parse("task") };
  const request = MessageToFirstmateSchema.parse({
    requestId: "req",
    destination: { kind: "task", task, attemptId: AttemptId.parse("s1") },
    text: "What happened?",
  });
  try {
    await sendMessage(f.installation, store, request, refuseRegistration).catch(() => {});
    await writeFile(join(f.installation.home, "state/task.meta"), "spawn_gen=s2\n");
    const reply = {
      kind: "reply",
      messageId: "answer",
      requestId: "req",
      content: { kind: "text", text: "The plan is ready." },
    };
    const received = await receiveMessage(f.installation, store, reply);
    expect(received.relevance).toBe("historical");
    store.close();
    store = new AdapterStore(f.database, { existing: true });
    expect(await receiveMessage(f.installation, store, reply)).toEqual(received);
    expect(
      String(
        (await receiveMessage(f.installation, store, { ...reply, messageId: "followup" }))
          .messageId,
      ),
    ).toBe("followup");
    await expect(
      receiveMessage(f.installation, store, {
        ...reply,
        messageId: "unknown",
        requestId: "absent",
      }),
    ).rejects.toMatchObject({ code: "firstmate.unknown_request" });
    await expect(
      receiveMessage(f.installation, store, {
        ...reply,
        content: { kind: "text", text: "Changed" },
      }),
    ).rejects.toMatchObject({ code: "firstmate.conflict" });
    await expect(
      receiveMessage(f.installation, store, {
        kind: "report",
        messageId: "report",
        attempt: { task: { ...task, homeId: "other" }, attemptId: "s2" },
        content: reply.content,
      }),
    ).rejects.toMatchObject({ code: "firstmate.scope_mismatch" });
  } finally {
    store.close();
  }
});
