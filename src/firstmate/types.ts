import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
export const HomeId = id.brand<"HomeId">();
export const RequestId = id.brand<"RequestId">();
export const MessageId = id.brand<"MessageId">();
export const TaskId = id.brand<"TaskId">();
export const AttemptId = id.brand<"AttemptId">();
export const Digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .brand<"Digest">();
export const TaskRef = z.object({ homeId: HomeId, taskId: TaskId }).strict();
export const AttemptRef = z.object({ task: TaskRef, attemptId: AttemptId }).strict();
export type FirstmateTaskRef = z.infer<typeof TaskRef>;
export type FirstmateTaskAttemptRef = z.infer<typeof AttemptRef>;
export type Fingerprint = z.infer<typeof Digest>;
export const Capability = z.enum(["task-state", "briefs", "messages"]);
export type Capability = z.infer<typeof Capability>;
export interface FirstmateInstallation {
  homeId: z.infer<typeof HomeId>;
  home: string;
  codeRoot: string;
  commit: string | null;
  fingerprint: Fingerprint;
  platform: string;
}
export interface CapabilityCheck {
  capability: Capability;
  status: "passed" | "failed" | "not-verified";
  evidence: string[];
}
export interface FirstmateInstallationCheck {
  schemaVersion: 1;
  checkId: string;
  installation: FirstmateInstallation;
  adapterVersion: string;
  suiteVersion: string;
  checkedAt: string;
  capabilities: CapabilityCheck[];
}
export interface FirstmateTaskSnapshot {
  task: FirstmateTaskRef;
  attempt: FirstmateTaskAttemptRef | null;
  observedAt: string;
  activity: { state: string; source: string };
  dependencies: { status: "unknown"; reason: "no-verified-contract" };
  briefRevision: Fingerprint | null;
}
export const BriefUpdate = z
  .object({
    task: TaskRef,
    expectedRevision: Digest,
    instructions: z.object({ text: z.string().min(1).max(12000), version: id }).strict(),
  })
  .strict();
export type FirstmateBriefUpdateRequest = z.infer<typeof BriefUpdate>;
export const BriefReceipt = z
  .object({
    receiptId: z.uuid(),
    task: TaskRef,
    previousRevision: Digest,
    revision: Digest,
    instructionVersion: id,
    instructionDigest: Digest,
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type FirstmateBriefUpdateReceipt = z.infer<typeof BriefReceipt>;
export interface FirstmateBriefCheck {
  attempt: FirstmateTaskAttemptRef;
  status: "included" | "missing" | "not-verified";
  reason: "matched" | "instructions-absent" | "attempt-changed" | "launch-evidence-unavailable";
  observedAt: string;
  launchRevision: Fingerprint | null;
}
export const Destination = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("home"), homeId: HomeId }).strict(),
  z.object({ kind: z.literal("task"), task: TaskRef, attemptId: AttemptId.optional() }).strict(),
]);
export const MessageToFirstmateSchema = z
  .object({
    requestId: RequestId,
    destination: Destination,
    text: z.string().min(1).max(12000),
    context: z.string().max(8000).default(""),
    expectedResponse: z.enum(["text", "task-report"]).default("text"),
  })
  .strict();
export type MessageToFirstmate = z.infer<typeof MessageToFirstmateSchema>;
export const Content = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(16000) }).strict(),
  z
    .object({
      kind: z.literal("task-report"),
      summary: z.string().min(1).max(12000),
      artifacts: z
        .array(z.object({ title: z.string().max(200), url: z.url().max(2000) }).strict())
        .max(20),
    })
    .strict(),
]);
export const IncomingSubmission = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("reply"),
      messageId: MessageId,
      requestId: RequestId,
      content: Content,
    })
    .strict(),
  z
    .object({
      kind: z.literal("report"),
      messageId: MessageId,
      attempt: AttemptRef,
      content: Content,
    })
    .strict(),
]);
export type IncomingSubmission = z.infer<typeof IncomingSubmission>;
export type MessageFromFirstmate = IncomingSubmission & {
  homeId: z.infer<typeof HomeId>;
  receivedAt: string;
  relevance: "current" | "historical" | "unknown";
};
export interface MessageToFirstmateReceipt {
  requestId: z.infer<typeof RequestId>;
  receiptId: string;
  acceptedAt: string;
  delivery: "queued" | "offered" | "captured";
  sourceId: string;
}

export const InstallationCheckSchema = z.object({
  schemaVersion: z.literal(1),
  checkId: z.uuid(),
  installation: z.object({
    homeId: HomeId,
    home: z.string(),
    codeRoot: z.string(),
    commit: z.string().nullable(),
    fingerprint: Digest,
    platform: z.string(),
  }),
  adapterVersion: z.string(),
  suiteVersion: z.string(),
  checkedAt: z.iso.datetime(),
  capabilities: z.array(
    z.object({
      capability: Capability,
      status: z.enum(["passed", "failed", "not-verified"]),
      evidence: z.array(z.string()),
    }),
  ),
});
