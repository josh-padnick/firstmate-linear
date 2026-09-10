import { chmod, cp, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createExtensionPackage } from "./extension-package";
import { getFirstmateInstallation } from "./installation";
import type { IsolatedFirstmate } from "./isolation";
import { deliveryReceipt, receiveMessage, sendMessage } from "./messages";
import { AdapterStore } from "./store";
import { MessageToFirstmateSchema } from "./types";

export async function messageProbe(
  fixture: IsolatedFirstmate,
  answer = "Fixture response: the revised plan uses single-use invitations that expire after seven days.",
) {
  const binary =
    basename(process.execPath) === "bun"
      ? fileURLToPath(new URL("../../.build/fm-linear", import.meta.url))
      : process.execPath;
  const runtime = join(fixture.root, "fm-linear");
  await cp(binary, runtime);
  await chmod(runtime, 0o755);
  const pkg = await createExtensionPackage(join(fixture.root, "package"), runtime);
  const execute = (command: string, args: string[]) => fixture.run(command, args, {}, 60000);
  const bind = await execute("/bin/bash", [
    join(fixture.codeRoot, "bin/fm-extension.sh"),
    "bind",
    pkg.packageRoot,
    "--adapter",
    "fm-linear",
    "--trust-same-user-code",
  ]);
  if (bind.code !== 0) throw new Error(`Binding failed: ${bind.stderr}`);
  const isolated = await getFirstmateInstallation({
    home: fixture.home,
    codeRoot: fixture.codeRoot,
  });
  const database = join(fixture.root, "adapter-state", "adapter.sqlite");
  let store = new AdapterStore(database);
  const request = MessageToFirstmateSchema.parse({
    requestId: "probe-request",
    destination: { kind: "home", homeId: isolated.homeId },
    text: "Revise the invitation plan so links expire after seven days.",
    context:
      "Task: add team invitations to the app. The plan must also require single-use links. This is a synthetic transport check; do not launch agents.",
  });
  try {
    const receipt = await sendMessage(isolated, store, request, execute);
    store.close();
    store = new AdapterStore(database, { existing: true });
    const capture = await execute("/bin/bash", [
      join(fixture.codeRoot, "bin/fm-procevent.sh"),
      "start",
      receipt.sourceId,
    ]);
    if (capture.code !== 0) throw new Error(`Capture failed: ${capture.stderr}`);
    if ((await deliveryReceipt(isolated, store, request.requestId)).delivery !== "captured")
      throw new Error("No durable capture evidence");
    const retry = await sendMessage(isolated, store, request, execute);
    if (retry.receiptId !== receipt.receiptId || retry.delivery !== "captured")
      throw new Error("Replay lost its receipt");
    const captures = (await readdir(join(fixture.home, "state/procevent-inbox"))).filter(
      (f) => f.startsWith(receipt.sourceId) && f.endsWith(".result"),
    );
    if (captures.length !== 1) throw new Error("Duplicate capture");
    const classification = await execute("/bin/bash", [
      join(fixture.codeRoot, "bin/fm-procevent.sh"),
      "classify",
      join(fixture.home, "state/procevent-inbox", captures[0] ?? ""),
    ]);
    if (classification.code !== 0 || classification.stdout.trim() !== "fm-linear-request")
      throw new Error(`Classification failed: ${classification.stderr}`);
    const reply = {
      kind: "reply",
      messageId: "probe-response",
      requestId: request.requestId,
      content: { kind: "text", text: answer },
    };
    const answerFile = join(fixture.root, "answer.json");
    await writeFile(answerFile, JSON.stringify(reply.content), { mode: 0o600 });
    const submitted = await execute(runtime, [
      "respond",
      request.requestId,
      "--input",
      answerFile,
      "--message-id",
      reply.messageId,
      "--home",
      fixture.home,
      "--code-root",
      fixture.codeRoot,
      "--state",
      database,
      "--json",
    ]);
    if (submitted.code !== 0) throw new Error(`Response command failed: ${submitted.stderr}`);
    const received = JSON.parse(submitted.stdout);
    store.close();
    store = new AdapterStore(database, { existing: true });
    if (JSON.stringify(await receiveMessage(isolated, store, reply)) !== JSON.stringify(received))
      throw new Error("Response replay changed");
    let unknownRejected = false;
    try {
      await receiveMessage(isolated, store, {
        ...reply,
        messageId: "unknown-response",
        requestId: "unknown-request",
      });
    } catch (error) {
      unknownRejected =
        error instanceof Error && "code" in error && error.code === "firstmate.unknown_request";
    }
    if (!unknownRejected) throw new Error("An unknown request was accepted");
    return {
      request,
      receipt: retry,
      response: received,
      captureCount: captures.length,
      unknownRequestRejected: true,
      database,
    };
  } finally {
    store.close();
  }
}
