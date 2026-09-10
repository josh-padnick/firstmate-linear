import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { commandEnvironment, runCommand } from "../support/command";
import { FmError } from "../support/errors";
import { confinedFile, hash, readBounded } from "../support/files";
import { metadata } from "./installation";
import type { AdapterStore } from "./store";
import {
  type FirstmateInstallation,
  IncomingSubmission,
  type MessageFromFirstmate,
  type MessageToFirstmate,
  type MessageToFirstmateReceipt,
  MessageToFirstmateSchema,
} from "./types";
export const EXTENSION_ID = "org.fm-linear.messages";
export const EXTENSION_VERSION = "0.1.0";
export const EXTENSION_ADAPTER = "fm-linear";
interface RequestRow {
  payload: string;
  receipt: string;
}
function requestRow(store: AdapterStore, home: string, id: string): RequestRow | null {
  return store.db
    .query<RequestRow, [string, string]>(
      "SELECT payload,receipt FROM requests WHERE home=? AND id=?",
    )
    .get(home, id);
}
export function packet(message: MessageToFirstmate): string {
  return JSON.stringify({
    schema: "fm-linear.request.v1",
    ...message,
    responseInstructions:
      'Submit a reply using fm-linear respond REQUEST_ID --input ANSWER_JSON_FILE with the configured --home, --code-root and --state flags. The answer file is a content object: {kind:"text",text:"your answer"}, or the requested task-report content. For a distinct follow-up use a new --message-id. Receipt of this request does not resolve it. The caller decides workflow actions.',
  });
}
export async function sendMessage(
  installation: FirstmateInstallation,
  store: AdapterStore,
  input: MessageToFirstmate,
  execute: typeof runCommand = runCommand,
): Promise<MessageToFirstmateReceipt> {
  const message = MessageToFirstmateSchema.parse(input);
  const home =
    message.destination.kind === "home"
      ? message.destination.homeId
      : message.destination.task.homeId;
  if (home !== installation.homeId)
    throw new FmError(
      "firstmate.scope_mismatch",
      "The message destination belongs to another home.",
    );
  if (Buffer.byteLength(packet(message)) > 30000)
    throw new FmError("config.invalid", "The message exceeds the Firstmate event size limit.");
  const receipt = store.db.transaction(() => {
    const prior = requestRow(store, home, message.requestId);
    if (prior) {
      if (prior.payload !== JSON.stringify(message))
        throw new FmError(
          "firstmate.conflict",
          "This request ID already identifies different content.",
        );
      return JSON.parse(prior.receipt) as MessageToFirstmateReceipt;
    }
    const value: MessageToFirstmateReceipt = {
      requestId: message.requestId,
      receiptId: randomUUID(),
      acceptedAt: new Date().toISOString(),
      delivery: "queued",
      sourceId: `fml-${hash(`${home}:${message.requestId}`).slice(0, 24)}`,
    };
    store.db
      .query("INSERT INTO requests(home,id,payload,receipt) VALUES(?,?,?,?)")
      .run(home, message.requestId, JSON.stringify(message), JSON.stringify(value));
    return value;
  })();
  if ((await deliveryReceipt(installation, store, message.requestId)).delivery === "captured")
    return deliveryReceipt(installation, store, message.requestId);
  // Registration is idempotent only after inspecting its exact existing configuration.
  const configRef = `fm-linear:${Buffer.from(JSON.stringify({ db: store.path, homeId: home, requestId: message.requestId })).toString("base64url")}`;
  const registration = await confinedFile(
    installation.home,
    ["state", "procevent", `${receipt.sourceId}.source`],
    true,
  );
  if (registration) {
    const content = await readBounded(registration);
    if (
      !content.includes(`adapter=${EXTENSION_ADAPTER}\n`) ||
      !content.includes(`config_ref=${configRef}\n`)
    )
      throw new FmError(
        "firstmate.conflict",
        "The process-event source belongs to different configuration.",
      );
  } else {
    const result = await execute(
      "/bin/bash",
      [
        `${installation.codeRoot}/bin/fm-procevent.sh`,
        "register-extension",
        EXTENSION_ADAPTER,
        receipt.sourceId,
        "--config-ref",
        configRef,
      ],
      {
        cwd: installation.home,
        env: commandEnvironment(installation.home, installation.codeRoot),
        timeoutMs: 30000,
      },
    );
    if (result.code !== 0)
      throw new FmError(
        "firstmate.command_failed",
        "The message is saved, but its Firstmate source registration was not confirmed.",
        "unknown",
      );
  }
  return deliveryReceipt(installation, store, message.requestId);
}
export async function deliveryReceipt(
  installation: FirstmateInstallation,
  store: AdapterStore,
  id: string,
): Promise<MessageToFirstmateReceipt> {
  const row = requestRow(store, installation.homeId, id);
  if (!row)
    throw new FmError("firstmate.unknown_request", "The request was not found in this home.");
  const receipt = JSON.parse(row.receipt) as MessageToFirstmateReceipt;
  const offered = store.db
    .query("SELECT 1 FROM polls WHERE home=? AND request_id=?")
    .get(installation.homeId, id);
  let delivery: MessageToFirstmateReceipt["delivery"] =
    receipt.delivery === "captured" ? "captured" : offered ? "offered" : "queued";
  const files = await readdir(`${installation.home}/state/procevent-inbox`).catch(
    (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [];
      throw e;
    },
  );
  for (const file of files.filter(
    (f) => f.startsWith(`${receipt.sourceId}.`) && f.endsWith(".result"),
  )) {
    const path = await confinedFile(installation.home, ["state", "procevent-inbox", file]);
    const owner = await confinedFile(
      installation.home,
      ["state", "procevent-inbox", file.replace(/\.result$/, ".extension")],
      true,
    );
    if (
      path &&
      owner &&
      (await readBounded(owner)).includes(`extension_id=${EXTENSION_ID}\n`) &&
      (await readBounded(path, 32768)).trim() === packet(JSON.parse(row.payload))
    ) {
      delivery = "captured";
      break;
    }
  }
  const value = { ...receipt, delivery };
  store.db
    .query("UPDATE requests SET receipt=? WHERE home=? AND id=?")
    .run(JSON.stringify(value), installation.homeId, id);
  return value;
}
/** A trusted local submitter supplies content; the adapter supplies the configured origin. */
export async function receiveMessage(
  installation: FirstmateInstallation,
  store: AdapterStore,
  input: unknown,
): Promise<MessageFromFirstmate> {
  const message = IncomingSubmission.parse(input);
  const previous = store.get<{ submission: IncomingSubmission; message: MessageFromFirstmate }>(
    installation.homeId,
    "incoming",
    message.messageId,
  );
  if (previous) {
    if (JSON.stringify(previous.submission) !== JSON.stringify(message))
      throw new FmError(
        "firstmate.conflict",
        "This message ID already identifies different content.",
      );
    return previous.message;
  }
  let relevance: MessageFromFirstmate["relevance"] = "unknown";
  if (message.kind === "reply") {
    const row = requestRow(store, installation.homeId, message.requestId);
    if (!row)
      throw new FmError(
        "firstmate.unknown_request",
        "The reply does not match a request in this home.",
      );
    const request = MessageToFirstmateSchema.parse(JSON.parse(row.payload));
    if (request.expectedResponse !== message.content.kind)
      throw new FmError(
        "config.invalid",
        "The reply does not match the requested response contract.",
      );
    if (request.destination.kind === "home") relevance = "current";
    else if (request.destination.attemptId) {
      const generation = (await metadata(installation.home, request.destination.task.taskId))
        ?.spawn_gen;
      relevance = generation
        ? generation === request.destination.attemptId
          ? "current"
          : "historical"
        : "unknown";
    }
  } else {
    if (message.attempt.task.homeId !== installation.homeId)
      throw new FmError("firstmate.scope_mismatch", "The report belongs to another home.");
    const generation = (await metadata(installation.home, message.attempt.task.taskId))?.spawn_gen;
    relevance = generation
      ? generation === message.attempt.attemptId
        ? "current"
        : "historical"
      : "unknown";
  }
  return store.db.transaction(() => {
    const prior = store.get<{ submission: IncomingSubmission; message: MessageFromFirstmate }>(
      installation.homeId,
      "incoming",
      message.messageId,
    );
    if (prior) {
      if (JSON.stringify(prior.submission) !== JSON.stringify(message))
        throw new FmError(
          "firstmate.conflict",
          "This message ID already identifies different content.",
        );
      return prior.message;
    }
    const value: MessageFromFirstmate = {
      ...message,
      homeId: installation.homeId,
      receivedAt: new Date().toISOString(),
      relevance,
    };
    store.put(installation.homeId, "incoming", message.messageId, {
      submission: message,
      message: value,
    });
    return value;
  })();
}
export function pollRequest(
  store: AdapterStore,
  home: string,
  requestId: string,
  hostRequest: string,
): { status: "result" | "no-result"; output: string } {
  return store.db.transaction(() => {
    const row = requestRow(store, home, requestId);
    if (!row) throw new FmError("firstmate.unknown_request", "The source request is unavailable.");
    const existing = store.db
      .query<{ host_request: string }, [string, string]>(
        "SELECT host_request FROM polls WHERE home=? AND request_id=?",
      )
      .get(home, requestId);
    if (existing && existing.host_request !== hostRequest)
      throw new FmError(
        "firstmate.conflict",
        "A different host invocation already offered this request; verify capture before retrying.",
        "unknown",
      );
    store.db
      .query("INSERT OR IGNORE INTO polls(home,host_request,request_id) VALUES(?,?,?)")
      .run(home, hostRequest, requestId);
    const bound = store.db
      .query<{ request_id: string }, [string, string]>(
        "SELECT request_id FROM polls WHERE home=? AND host_request=?",
      )
      .get(home, hostRequest);
    if (bound?.request_id !== requestId)
      throw new FmError(
        "firstmate.conflict",
        "The host invocation is already bound to another request.",
      );
    return {
      status: "result" as const,
      output: packet(MessageToFirstmateSchema.parse(JSON.parse(row.payload))),
    };
  })();
}
