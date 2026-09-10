import { randomUUID } from "node:crypto";
import { FmError } from "../support/errors";
import {
  confinedFile,
  hash,
  readBounded,
  readBoundedSync,
  replaceBriefSync,
} from "../support/files";
import { metadata } from "./installation";
import type { AdapterStore } from "./store";
import {
  AttemptRef,
  BriefReceipt,
  BriefUpdate,
  type FirstmateBriefCheck,
  type FirstmateBriefUpdateReceipt,
  type FirstmateBriefUpdateRequest,
  type FirstmateInstallation,
  type FirstmateTaskAttemptRef,
} from "./types";

const START = "<!-- fm-linear:instructions:start -->";
const END = "<!-- fm-linear:instructions:end -->";
export function instructionBlock(text: string, version: string): string {
  if (text.includes("<!-- fm-linear:") || /\r/.test(text))
    throw new FmError(
      "config.invalid",
      "Instruction text contains a reserved marker or carriage return.",
    );
  return `${START}\n<!-- version: ${version} -->\n${text}\n${END}\n`;
}
export function editBrief(source: string, block: string): string {
  const matches = [...source.matchAll(/^## Firstmate spec\s*$/gm)];
  if (matches.length !== 1 || !/^## Captain's intent\s*$/m.test(source))
    throw new FmError(
      "firstmate.contract_failed",
      "The authored brief lacks the expected task sections.",
    );
  const match = matches[0];
  if (!match || match.index === undefined)
    throw new FmError("firstmate.contract_failed", "Missing Firstmate section.");
  const begin = match.index + match[0].length;
  const next = /^#{1,2} /m.exec(source.slice(begin));
  const finish = next?.index !== undefined ? begin + next.index : source.length;
  const section = source.slice(begin, finish);
  const start = section.indexOf(START);
  const end = section.indexOf(END);
  if (
    (source.match(/<!-- fm-linear:instructions:start -->/g)?.length ?? 0) !==
      (start >= 0 ? 1 : 0) ||
    (source.match(/<!-- fm-linear:instructions:end -->/g)?.length ?? 0) !== (end >= 0 ? 1 : 0) ||
    start < 0 !== end < 0 ||
    end < start
  )
    throw new FmError("firstmate.contract_failed", "The managed instruction section is malformed.");
  if (start >= 0)
    return (
      source.slice(0, begin) +
      section.slice(0, start) +
      block +
      section.slice(end + END.length).replace(/^\n/, "") +
      source.slice(finish)
    );
  return `${source.slice(0, finish).replace(/\n*$/, "\n\n") + block}\n${source.slice(finish)}`;
}
export async function updateBrief(
  installation: FirstmateInstallation,
  store: AdapterStore,
  input: FirstmateBriefUpdateRequest,
): Promise<FirstmateBriefUpdateReceipt> {
  const request = BriefUpdate.parse(input);
  if (request.task.homeId !== installation.homeId)
    throw new FmError("firstmate.scope_mismatch", "The task belongs to another home.");
  const path = await confinedFile(installation.home, ["data", request.task.taskId, "brief.md"]);
  if (!path) throw new FmError("firstmate.contract_failed", "The authored brief is missing.");
  const block = instructionBlock(request.instructions.text, request.instructions.version);
  const operation = hash(JSON.stringify(request));
  const source = await readBounded(path);
  const revision = hash(source);
  const existing = store.get<FirstmateBriefUpdateReceipt>(installation.homeId, "brief", operation);
  if (existing && revision === existing.revision) return existing;
  if (revision !== request.expectedRevision) {
    // Recover a crash after atomic file replacement but before receipt persistence.
    const pending = store.get<FirstmateBriefUpdateReceipt>(
      installation.homeId,
      "brief-intent",
      operation,
    );
    if (pending && revision === pending.revision) {
      store.put(installation.homeId, "brief", operation, pending);
      return pending;
    }
    throw new FmError("firstmate.stale_brief", "The expected brief revision no longer matches.");
  }
  const next = editBrief(source, block);
  const receipt: FirstmateBriefUpdateReceipt = {
    receiptId: randomUUID(),
    task: request.task,
    previousRevision: revision,
    revision: hash(next),
    instructionVersion: request.instructions.version,
    instructionDigest: hash(block),
    updatedAt: new Date().toISOString(),
  };
  const intent = store.once(installation.homeId, "brief-intent", operation, receipt);
  return store.db
    .transaction(() => {
      const current = hash(readBoundedSync(path));
      const prior = store.get<FirstmateBriefUpdateReceipt>(installation.homeId, "brief", operation);
      if (prior && current === prior.revision) return prior;
      if (current !== revision)
        throw new FmError("firstmate.stale_brief", "The brief changed before publication.");
      if (next !== source) replaceBriefSync(path, revision, next);
      store.put(installation.homeId, "brief", operation, intent);
      return intent;
    })
    .immediate();
}
export async function checkBrief(
  installation: FirstmateInstallation,
  receipt: FirstmateBriefUpdateReceipt,
  input: FirstmateTaskAttemptRef,
): Promise<FirstmateBriefCheck> {
  receipt = BriefReceipt.parse(receipt);
  const attempt = AttemptRef.parse(input);
  if (
    attempt.task.homeId !== installation.homeId ||
    receipt.task.homeId !== installation.homeId ||
    attempt.task.taskId !== receipt.task.taskId
  )
    throw new FmError(
      "firstmate.scope_mismatch",
      "The receipt and launch must refer to the same task and home.",
    );
  const base = { attempt, observedAt: new Date().toISOString(), launchRevision: null };
  const before = await metadata(installation.home, attempt.task.taskId);
  if (before?.spawn_gen !== attempt.attemptId)
    return { ...base, status: "not-verified", reason: "attempt-changed" };
  const path = await confinedFile(
    installation.home,
    ["data", attempt.task.taskId, "launch-brief.md"],
    true,
  );
  if (!path) return { ...base, status: "not-verified", reason: "launch-evidence-unavailable" };
  const content = await readBounded(path, 256 * 1024);
  const after = await metadata(installation.home, attempt.task.taskId);
  if (after?.spawn_gen !== attempt.attemptId)
    return { ...base, status: "not-verified", reason: "attempt-changed" };
  const a = content.indexOf(START);
  const b = content.indexOf(END, a);
  const block = a >= 0 && b >= a ? `${content.slice(a, b + END.length)}\n` : "";
  return {
    ...base,
    launchRevision: hash(content),
    status: hash(block) === receipt.instructionDigest ? "included" : "missing",
    reason: hash(block) === receipt.instructionDigest ? "matched" : "instructions-absent",
  };
}
