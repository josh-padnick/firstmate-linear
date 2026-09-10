import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { FirstmateAdapter } from "../src/firstmate/adapter";
import { runBriefProbe } from "../src/firstmate/brief-probe";
import { getFirstmateInstallation } from "../src/firstmate/installation";
import { IsolatedFirstmate } from "../src/firstmate/isolation";
import { messageProbe } from "../src/firstmate/message-probe";
import { TaskId } from "../src/firstmate/types";
import { normalizeError } from "../src/support/errors";

const mode = process.argv[2];
const source = process.env.FIRSTMATE_SOURCE;
if (!source || !["compatibility", "tasks", "briefs", "messages"].includes(mode ?? ""))
  throw new Error(
    "Set FIRSTMATE_SOURCE, then run bun run scripts/review.ts compatibility|tasks|briefs|messages.",
  );
const fixture = await IsolatedFirstmate.create(source);
const adapter = await FirstmateAdapter.open({
  home: fixture.home,
  codeRoot: fixture.codeRoot,
  database: join(fixture.root, "review-state", "adapter.sqlite"),
});
const terminal = process.stdin.isTTY
  ? createInterface({ input: process.stdin, output: process.stdout })
  : null;
const pause = async (text: string) => {
  if (terminal) await terminal.question(`${text} Press Enter to continue. `);
};
try {
  console.log(`Disposable fixture: ${fixture.root}`);
  if (mode === "compatibility") {
    console.log(
      "Binding the package in this disposable home before checking its message capability.",
    );
    await messageProbe(fixture);
    console.log(JSON.stringify(await adapter.testFirstmateInstallation(), null, 2));
    await pause("All three capabilities should pass. Next, break only the copied state command.");
    const path = join(fixture.codeRoot, "bin/fm-crew-state.sh");
    const original = await readFile(path, "utf8");
    await writeFile(path, "#!/bin/bash\necho changed-contract\n");
    try {
      await adapter.getFirstmateTask({
        homeId: adapter.installation.homeId,
        taskId: TaskId.parse("sample"),
      });
      throw new Error("The stale capability was not held.");
    } catch (error) {
      if (
        !["firstmate.capability_held", "firstmate.scope_mismatch"].includes(
          normalizeError(error).code,
        )
      )
        throw error;
      console.log(normalizeError(error).toJSON());
    }
    console.log(JSON.stringify(await adapter.testFirstmateInstallation(["task-state"]), null, 2));
    await pause(
      "The state capability should be held, and the changed contract should fail. Next, restore the script and recheck.",
    );
    await writeFile(path, original);
    console.log(JSON.stringify(await adapter.testFirstmateInstallation(["task-state"]), null, 2));
  } else if (mode === "tasks") {
    await adapter.testFirstmateInstallation(["task-state"]);
    const secondHome = join(fixture.root, "second-home");
    await mkdir(secondHome);
    const other = await getFirstmateInstallation({ home: secondHome, codeRoot: fixture.codeRoot });
    console.log({
      firstHomeId: adapter.installation.homeId,
      secondHomeId: other.homeId,
      sameTaskName: "sample",
    });
    console.log(
      await adapter.getFirstmateTask({
        homeId: adapter.installation.homeId,
        taskId: TaskId.parse("sample"),
      }),
    );
    try {
      await adapter.getFirstmateTask({ homeId: other.homeId, taskId: TaskId.parse("sample") });
      throw new Error("Cross-home task was not rejected.");
    } catch (error) {
      if (
        !["firstmate.capability_held", "firstmate.scope_mismatch"].includes(
          normalizeError(error).code,
        )
      )
        throw error;
      console.log(normalizeError(error).toJSON());
    }
  } else if (mode === "briefs") {
    console.log(await runBriefProbe(fixture));
    await pause(
      "Open the authored and launch brief paths above. Captain text should be preserved and the recap instruction should appear once.",
    );
    const omitted = await IsolatedFirstmate.create(source);
    try {
      console.log(await runBriefProbe(omitted, true));
      await pause(
        "The second launch deliberately omitted the instruction. Its result should be missing.",
      );
    } finally {
      await omitted.close();
    }
  } else {
    console.log(
      "Example: revise the invitation plan to require single-use links that expire after seven days.",
    );
    const answer = terminal
      ? await terminal.question("Enter a short fixture reply (or press Enter for the sample): ")
      : "";
    console.log(await messageProbe(fixture, answer || undefined));
    console.log(
      "A caller would use requestId to retrieve its own Linear issue/thread mapping. The adapter does not store that mapping.",
    );
  }
  await pause("Inspect the results and fixture files before cleanup.");
} finally {
  terminal?.close();
  adapter.close();
  await fixture.close();
}
