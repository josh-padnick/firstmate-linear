import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { hash, readBounded } from "../support/files";
import { checkBrief, updateBrief } from "./briefs";
import { getFirstmateInstallation, metadata } from "./installation";
import type { IsolatedFirstmate } from "./isolation";
import { briefLaunch, briefPrepare } from "./probe-scripts";
import { AdapterStore } from "./store";
import { AttemptId, TaskId } from "./types";

export async function runBriefProbe(fixture: IsolatedFirstmate, omit = false) {
  const script = join(fixture.root, "brief-probe.sh");
  await writeFile(script, briefPrepare);
  const prepared = await fixture.run(
    "/bin/bash",
    [script, fixture.codeRoot, fixture.home],
    {},
    60000,
  );
  if (prepared.code !== 0) throw new Error("The installed brief scaffold contract failed.");
  const isolated = await getFirstmateInstallation({
    home: fixture.home,
    codeRoot: fixture.codeRoot,
  });
  const task = {
    homeId: isolated.homeId,
    taskId: TaskId.parse(basename(fixture.scratch).slice(3)),
  };
  const path = join(fixture.home, "data", task.taskId, "brief.md");
  const original = await readBounded(path);
  const store = new AdapterStore(join(fixture.root, "brief-state", "adapter.sqlite"));
  try {
    const receipt = await updateBrief(isolated, store, {
      task,
      expectedRevision: hash(original),
      instructions: {
        text: "Create an interactive recap. FM_LINEAR_PROBE_RECAP",
        version: "probe-v1",
      },
    });
    if (omit) await writeFile(path, original);
    await writeFile(script, briefLaunch);
    const launched = await fixture.run(
      "/bin/bash",
      [script, fixture.codeRoot, fixture.home],
      {},
      60000,
    );
    if (launched.code !== 0 || !launched.stdout.includes("brief-contract-passed"))
      throw new Error("The installed launch preservation contract failed.");
    const attempt = {
      task,
      attemptId: AttemptId.parse((await metadata(fixture.home, task.taskId))?.spawn_gen),
    };
    const check = await checkBrief(isolated, receipt, attempt);
    if (check.status !== (omit ? "missing" : "included"))
      throw new Error("Launch evidence did not match the prepared instructions.");
    return {
      receipt,
      check,
      authoredBrief: path,
      launchBrief: join(fixture.home, "data", task.taskId, "launch-brief.md"),
    };
  } finally {
    store.close();
  }
}
