import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { FirstmateAdapter } from "../src/firstmate/adapter";
import { runBriefProbe } from "../src/firstmate/brief-probe";
import { getFirstmateInstallation } from "../src/firstmate/installation";
import { IsolatedFirstmate } from "../src/firstmate/isolation";
import { messageProbe } from "../src/firstmate/message-probe";
import { type Capability, type FirstmateInstallationCheck, TaskId } from "../src/firstmate/types";
import { commandEnvironment, runCommand } from "../src/support/command";
import { normalizeError } from "../src/support/errors";
import { type ReviewFormat, ReviewMismatch, ReviewOutput } from "./review-output";

const args = process.argv.slice(2);
const mode = args[0] ?? "unknown";
const formatIndex = args.indexOf("--format");
const requestedFormat = formatIndex >= 0 ? args[formatIndex + 1] : "human";
const format: ReviewFormat =
  requestedFormat === "json" || requestedFormat === "toon" ? requestedFormat : "human";
const output = new ReviewOutput(mode, format, args.includes("--verbose"));
const fixtures: IsolatedFirstmate[] = [];
let adapter: FirstmateAdapter | undefined;
let terminal: ReturnType<typeof createInterface> | undefined;
let exitCode = 0;
let sourceSummary = "";
const usage =
  "Set FIRSTMATE_SOURCE, then run bun run scripts/review.ts compatibility|tasks|briefs|messages [--format human|json|toon] [--verbose].";
const pause = async (text: string) => {
  if (terminal) await terminal.question(`\n${text}\nPress Enter to continue. `);
};
const capabilities = (
  report: FirstmateInstallationCheck,
  expected: Partial<Record<Capability, string>>,
) => {
  output.detail("Compatibility report", report);
  output.expect(
    "All requested checks returned",
    report.capabilities.length,
    Object.keys(expected).length,
  );
  for (const [key, status] of Object.entries(expected)) {
    const label =
      { "task-state": "Task state", briefs: "Brief preparation", messages: "Message delivery" }[
        key
      ] ?? key;
    output.expect(
      label,
      report.capabilities.find((c) => c.capability === key)?.status ?? "missing",
      status,
    );
  }
};
const expectError = async (name: string, operation: () => Promise<unknown>, code: string) => {
  let actual = "no-error";
  try {
    await operation();
  } catch (error) {
    actual = normalizeError(error).code;
  }
  output.expect(name, actual, code);
};
try {
  const remaining = args.slice(1);
  if (formatIndex >= 0) remaining.splice(formatIndex - 1, 2);
  if (
    !process.env.FIRSTMATE_SOURCE ||
    !["compatibility", "tasks", "briefs", "messages"].includes(mode) ||
    !["human", "json", "toon"].includes(requestedFormat ?? "") ||
    remaining.some((arg) => arg !== "--verbose") ||
    remaining.length > 1
  ) {
    exitCode = 2;
    output.fail({
      code: "review.invalid_arguments",
      summary: "The review command or source checkout is missing or invalid.",
      nextAction: usage,
    });
  } else {
    const source = await realpath(process.env.FIRSTMATE_SOURCE);
    terminal =
      format === "human" && process.stdin.isTTY && process.stdout.isTTY
        ? createInterface({ input: process.stdin, output: process.stdout })
        : undefined;
    output.say(
      `\nFirstmate ${mode} review\nUsing disposable fixtures. Your live Firstmate home is not used.`,
    );
    sourceSummary = `Firstmate source: ${source}`;
    const gitOptions = { cwd: source, env: commandEnvironment(source, source) };
    const revision = await runCommand(
      "/usr/bin/git",
      ["-C", source, "rev-parse", "HEAD"],
      gitOptions,
    ).catch(() => null);
    const commit =
      revision?.code === 0 && /^[a-f0-9]{40,64}\n?$/.test(revision.stdout)
        ? revision.stdout.trim()
        : null;
    const changes = commit
      ? await runCommand(
          "/usr/bin/git",
          ["-C", source, "status", "--porcelain", "--untracked-files=normal", "--", "bin"],
          gitOptions,
        ).catch(() => null)
      : null;
    const localChanges = changes?.code === 0 ? changes.stdout.length > 0 : null;
    sourceSummary += `\nCheckout HEAD: ${commit ? commit.slice(0, 12) : "unavailable (not a readable Git checkout)"}`;
    if (commit)
      sourceSummary +=
        localChanges === true
          ? " (local script changes)"
          : localChanges === null
            ? " (script changes unknown)"
            : "";
    output.say(`\n${sourceSummary}\n`);
    output.detail("Firstmate source", { path: source, commit, localScriptChanges: localChanges });
    output.say("Preparing isolated fixtures...");
    const fixture = await IsolatedFirstmate.create(source);
    fixtures.push(fixture);
    output.say(`Temporary fixture: ${fixture.root}\nFiles are removed when the review ends.`);
    if (format !== "human") output.detail("Disposable fixture", fixture.root);
    adapter = await FirstmateAdapter.open({
      home: fixture.home,
      codeRoot: fixture.codeRoot,
      database: join(fixture.root, "review-state", "adapter.sqlite"),
    });
    const currentAdapter = adapter;
    const task = { homeId: adapter.installation.homeId, taskId: TaskId.parse("sample") };
    if (mode === "compatibility") {
      output.step("Check the installed contracts");
      output.say("   Binding and checking the disposable extension...");
      await messageProbe(fixture);
      capabilities(await adapter.testFirstmateInstallation(["task-state", "briefs", "messages"]), {
        "task-state": "passed",
        briefs: "passed",
        messages: "passed",
      });
      await pause("Next, the review script will deliberately change the copied task-state script.");
      output.step("Simulate an incompatible Firstmate change");
      const path = join(fixture.codeRoot, "bin/fm-crew-state.sh");
      const original = await readFile(path, "utf8");
      await writeFile(path, "#!/bin/bash\necho changed-contract\n");
      await expectError(
        "Task reads were blocked",
        () => currentAdapter.getFirstmateTask(task),
        "firstmate.capability_held",
      );
      capabilities(await adapter.testFirstmateInstallation(["task-state"]), {
        "task-state": "failed",
      });
      output.say("         The contract failure was intentional and correctly detected.");
      await pause("Next, the review script will restore the copied script and check it again.");
      output.step("Restore Firstmate");
      await writeFile(path, original);
      capabilities(await adapter.testFirstmateInstallation(["task-state"]), {
        "task-state": "passed",
      });
    } else if (mode === "tasks") {
      output.step("Verify the task-state contract");
      capabilities(await adapter.testFirstmateInstallation(["task-state"]), {
        "task-state": "passed",
      });
      output.step("Keep task identities separate");
      const secondHome = join(fixture.root, "second-home");
      await mkdir(secondHome);
      const other = await getFirstmateInstallation({
        home: secondHome,
        codeRoot: fixture.codeRoot,
      });
      output.expect(
        "Different homes have different identities",
        other.homeId !== task.homeId,
        true,
      );
      const snapshot = await adapter.getFirstmateTask(task);
      output.detail("Task snapshot", snapshot);
      output.expect("Missing task activity stays unknown", snapshot.activity.state, "unknown");
      output.expect("No activity source is invented", snapshot.activity.source, "none");
      output.expect("No execution attempt is invented", snapshot.attempt === null, true);
      output.expect("Dependencies stay unknown", snapshot.dependencies.status, "unknown");
      await expectError(
        "A task from another home is rejected",
        () => currentAdapter.getFirstmateTask({ homeId: other.homeId, taskId: task.taskId }),
        "firstmate.scope_mismatch",
      );
    } else if (mode === "briefs") {
      output.step("Include workflow instructions in the launch brief");
      const prepared = await runBriefProbe(fixture);
      output.detail("Prepared brief", prepared);
      output.expect(
        "The launch includes the prepared instructions",
        prepared.check.status,
        "included",
      );
      output.say(
        `\n   Authored brief: ${prepared.authoredBrief}\n   Launch brief:   ${prepared.launchBrief}`,
      );
      await pause(
        "You can inspect these files. Next, deliberately omit the instructions in a second fixture.",
      );
      output.step("Detect missing instructions");
      const omitted = await IsolatedFirstmate.create(source);
      fixtures.push(omitted);
      const missing = await runBriefProbe(omitted, true);
      output.detail("Omitted instructions", missing);
      output.expect(
        "The omitted instructions are reported missing",
        missing.check.status,
        "missing",
      );
    } else {
      output.step("Deliver a request and correlate its reply");
      output.say(
        "   Request: revise the invitation plan to require single-use links that expire after seven days.",
      );
      const answer = terminal
        ? await terminal.question("\nEnter a fixture reply, or press Enter for the sample: ")
        : "";
      const result = await messageProbe(fixture, answer || undefined);
      output.detail("Message exchange", result);
      output.expect("Firstmate captured the request", result.receipt.delivery, "captured");
      output.expect("Retrying did not duplicate the capture", result.captureCount, 1);
      output.expect(
        "The reply belongs to the original request",
        result.response.requestId,
        result.request.requestId,
      );
      output.expect("An unknown request ID was rejected", result.unknownRequestRejected, true);
      output.say(`\n   Reply: ${JSON.stringify(result.response.content.text)}`);
      output.say("   The caller uses the request ID to find the original Linear thread.");
    }
    await pause("Review complete. Inspect any fixture files before cleanup.");
  }
} catch (error) {
  exitCode = 1;
  if (!(error instanceof ReviewMismatch)) {
    const normalized = normalizeError(error);
    output.fail({
      code: normalized.code,
      summary: normalized.message,
      nextAction: normalized.toJSON().nextAction,
    });
  }
} finally {
  terminal?.close();
  // Attempt every cleanup even if one resource fails to close.
  const cleanup = [() => adapter?.close(), ...fixtures.reverse().map((f) => () => f.close())];
  for (const close of cleanup) {
    try {
      await close();
    } catch {
      exitCode = 1;
      output.fail({
        code: "review.cleanup_failed",
        summary: "A disposable fixture could not be cleaned up.",
        nextAction: "Inspect the fixture paths in the detailed results.",
      });
    }
  }
}
if (sourceSummary) output.say(`\n${sourceSummary}`);
output.finish();
process.exitCode = exitCode;
