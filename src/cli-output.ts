import { stripVTControlCharacters } from "node:util";
import { encode } from "@toon-format/toon";
import type { FirstmateFleetSnapshot } from "./firstmate/fleet-types";
import { InstallationCheckSchema } from "./firstmate/types";
import { FmError } from "./support/errors";
import { logFailure } from "./support/logging";

export type OutputFormat = "human" | "json" | "toon";

export class CliUsageError extends FmError {
  constructor(
    summary: string,
    readonly hint: string,
  ) {
    super("config.invalid", summary);
  }
  override toJSON() {
    return { ...super.toJSON(), nextAction: this.hint };
  }
}

// Resolve a valid requested format even when strict argument parsing later fails.
export function requestedOutputFormat(args: string[]): OutputFormat {
  const options = args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--"));
  const index = options.findLastIndex((arg) => arg === "--format" || arg.startsWith("--format="));
  const requested = index < 0 ? undefined : (options[index]?.split("=")[1] ?? options[index + 1]);
  if (requested === "json" || requested === "toon") return requested;
  return options.includes("--json") ? "json" : "human";
}

const label = (key: string) => {
  const text = key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const plain = (value: unknown) => stripVTControlCharacters(String(value));

/** Render nested operation results without losing uncertainty or receipt identifiers. */
function fields(value: unknown, indent = ""): string {
  if (value === null) return "Not available";
  if (Array.isArray(value))
    return value.length
      ? value.map((item) => `${indent}- ${fields(item, `${indent}  `)}`).join("\n")
      : "None";
  if (typeof value === "object")
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => {
        const nested = item !== null && typeof item === "object";
        return `${indent}${label(key)}:${nested ? "\n" : " "}${fields(item, nested ? `${indent}  ` : "")}`;
      })
      .join("\n");
  return plain(value);
}

export function formatResult(command: string, result: unknown, format: OutputFormat): string {
  if (format === "json") return JSON.stringify(result);
  if (format === "toon") return encode(result);
  if (command === "fleet") {
    const fleet = result as FirstmateFleetSnapshot;
    return [
      `Firstmate fleet - ${fleet.coverage} coverage`,
      `Collected: ${fleet.collectedAt}\nRead time: ${(fleet.metrics.durationMs / 1000).toFixed(1)}s | Source reads: ${fleet.metrics.sourceReads} | Agent messages: ${fleet.metrics.agentMessages}`,
      ...fleet.homes.map((home) =>
        [
          `${home.owner.secondmateId ?? "Primary"}${home.route.host ? ` (${plain(home.route.host)})` : ""}`,
          `  Home: ${plain(home.route.home)}\n  ID: ${home.owner.homeId}`,
          `  Coverage: ${home.coverage} | Source age: ${home.ageSeconds === null ? "unknown" : `${Math.round(home.ageSeconds)}s`} (${home.freshness})`,
          ...(home.reasons.length ? [`  Notes: ${home.reasons.map(plain).join(", ")}`] : []),
          ...(home.retryAfter ? [`  Retry after: ${home.retryAfter}`] : []),
          "",
          `  ${"Task".padEnd(40)}  ${"State".padEnd(25)}  Attempt`,
          ...home.work.map(
            (work) =>
              `  ${plain(work.task.taskId).padEnd(40)}  ${plain(work.visibility === "last-known" ? `last-known: ${work.activity.state}` : work.backlogState && work.kind === "backlog" ? work.backlogState : work.activity.state).padEnd(25)}  ${work.attempt?.attemptId ?? "unknown"}`,
          ),
          ...(home.work.length ? [] : ["  No task records available."]),
        ].join("\n"),
      ),
      ...(fleet.coverage === "partial"
        ? [
            "Some inventory could not be verified. Last-known work is retained; it is not a completion signal.",
          ]
        : []),
    ].join("\n\n");
  }
  if (command === "test") {
    const report = InstallationCheckSchema.parse(result);
    const checks = report.capabilities.map((check) => {
      const status = { passed: "PASS", failed: "FAIL", "not-verified": "NOT VERIFIED" }[
        check.status
      ];
      return `  ${status}  ${check.capability}\n${check.evidence.map((item) => `    ${plain(item)}`).join("\n")}`;
    });
    return [
      "Firstmate compatibility check",
      fields(report.installation),
      ...checks,
      report.capabilities.every((check) => check.status === "passed")
        ? "All selected checks passed."
        : "Compatibility is not confirmed for every selected capability.",
    ].join("\n\n");
  }
  const title =
    {
      installation: "Firstmate installation",
      task: "Firstmate task",
      "brief-update": "Brief update receipt",
      "brief-check": "Brief instruction check",
      send: "Message delivery receipt",
      receive: "Message received from Firstmate",
      respond: "Reply recorded",
      "extension-package": "Extension package created",
    }[command] ?? "Result";
  return `${title}\n\n${fields(result)}`;
}

export function printFailure(error: FmError, format: OutputFormat) {
  // Keep the existing diagnostic schema and one process-level error boundary.
  logFailure(error, (line) => {
    if (format === "json") process.stderr.write(line);
    else if (format === "toon") process.stderr.write(`${encode(JSON.parse(line))}\n`);
    else {
      const record = error.toJSON();
      const hint = error instanceof CliUsageError ? error.hint : record.nextAction;
      process.stderr.write(
        `Error: ${plain(record.summary)}\n\n${plain(hint)}\n\nCode: ${record.code}\n`,
      );
      if (record.effect === "unknown")
        process.stderr.write("The operation's outcome is uncertain. Verify it before retrying.\n");
    }
  });
}
