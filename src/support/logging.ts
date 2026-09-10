import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ErrorRecord, type FmError } from "./errors";
export const Diagnostic = z.object({
  schemaVersion: z.literal(1),
  timestamp: z.iso.datetime(),
  runId: z.uuid(),
  scope: z.literal("firstmate"),
  event: z.literal("firstmate.operation_failed"),
  level: z.enum(["warn", "error"]),
  error: ErrorRecord,
});
const runId = randomUUID();
/** One process boundary; no payloads or raw exceptions are accepted by this sink. */
export function logFailure(
  error: FmError,
  sink: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
) {
  try {
    const record = Diagnostic.parse({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      runId,
      scope: "firstmate",
      event: "firstmate.operation_failed",
      level: error.code === "config.invalid" ? "warn" : "error",
      error: error.toJSON(),
    });
    sink(`${JSON.stringify(record)}\n`);
  } catch {
    try {
      process.stderr.write('{"schemaVersion":1,"event":"diagnostic_unavailable"}\n');
    } catch {}
  }
}
