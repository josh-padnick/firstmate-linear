import { randomUUID } from "node:crypto";
import { z } from "zod";

export const errorCodes = {
  "config.invalid": "Check the supplied input and retry.",
  "firstmate.scope_mismatch": "Select the Firstmate home that owns this task.",
  "firstmate.contract_failed": "Run fm-linear test and inspect the affected capability.",
  "firstmate.capability_held":
    "Run fm-linear test against the current installation before retrying.",
  "firstmate.stale_brief": "Read the current brief revision and review the requested update.",
  "firstmate.conflict": "Inspect the existing record before retrying with the same identity.",
  "firstmate.unknown_request": "Use the request ID supplied with the original message.",
  "firstmate.command_failed": "Check prerequisites and run fm-linear test.",
  "storage.unavailable": "Restore access to the local state directory before retrying.",
  "runtime.unexpected": "Inspect the local diagnostic and report the failure.",
} as const;
export type ErrorCode = keyof typeof errorCodes;
export class FmError extends Error {
  readonly schemaVersion = 1;
  readonly occurrenceId = randomUUID();
  readonly occurredAt = new Date().toISOString();
  readonly subsystem = "firstmate";
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly effect: "not-applicable" | "not-attempted" | "unknown" = "not-applicable",
  ) {
    super(message);
  }
  toJSON() {
    return {
      schemaVersion: this.schemaVersion,
      code: this.code,
      summary: this.message,
      nextAction: errorCodes[this.code],
      occurrenceId: this.occurrenceId,
      occurredAt: this.occurredAt,
      subsystem: this.subsystem,
      effect: this.effect,
      recovery: this.effect === "unknown" ? "verify-before-retry" : "intervention",
    };
  }
}
export function normalizeError(error: unknown): FmError {
  if (error instanceof FmError) return error;
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return new FmError("config.invalid", "The input does not match the documented JSON contract.");
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    ["EACCES", "EPERM", "ENOSPC", "EROFS", "SQLITE_BUSY", "SQLITE_FULL", "SQLITE_CORRUPT"].includes(
      String(error.code),
    )
  )
    return new FmError(
      "storage.unavailable",
      "Local storage is unavailable; accepted records remain pending.",
      "unknown",
    );
  return new FmError("runtime.unexpected", "The operation failed unexpectedly.", "unknown");
}

export const ErrorRecord = z.object({
  schemaVersion: z.literal(1),
  code: z.enum(Object.keys(errorCodes) as [ErrorCode, ...ErrorCode[]]),
  summary: z.string().max(1024),
  nextAction: z.string().max(1024),
  occurrenceId: z.uuid(),
  occurredAt: z.iso.datetime(),
  subsystem: z.literal("firstmate"),
  effect: z.enum(["not-applicable", "not-attempted", "unknown"]),
  recovery: z.enum(["verify-before-retry", "intervention"]),
});
