import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FirstmateAdapter } from "../src/firstmate/adapter";
import { getFirstmateInstallation } from "../src/firstmate/installation";
import { IsolatedFirstmate } from "../src/firstmate/isolation";
import { messageProbe } from "../src/firstmate/message-probe";
import { MessageToFirstmateSchema, TaskId } from "../src/firstmate/types";

test("installed contracts pass in OS isolation and a changed script invalidates the prior check", async () => {
  const source = process.env.FIRSTMATE_SOURCE;
  if (!source)
    throw new Error(
      "Required upstream fixture missing: set FIRSTMATE_SOURCE to a Firstmate checkout. See _internal/tmp/ADAPTER_REVIEW.md.",
    );
  const fixture = await IsolatedFirstmate.create(source);
  const root = await realpath(await mkdtemp(join(tmpdir(), "fm-contract-state-")));
  let adapter: FirstmateAdapter | undefined;
  try {
    adapter = await FirstmateAdapter.open({
      home: fixture.home,
      codeRoot: fixture.codeRoot,
      database: join(root, "private", "adapter.sqlite"),
    });
    // Catches: an isolated successful bind authorizing an unbound selected home.
    expect((await adapter.testFirstmateInstallation(["messages"])).capabilities[0]?.status).toBe(
      "failed",
    );
    await expect(
      adapter.sendFirstmateMessage(
        MessageToFirstmateSchema.parse({
          requestId: "unbound-request",
          destination: { kind: "home", homeId: adapter.installation.homeId },
          text: "Do not deliver",
        }),
      ),
    ).rejects.toMatchObject({ code: "firstmate.capability_held" });
    await messageProbe(fixture);
    const report = await adapter.testFirstmateInstallation();
    expect(report.capabilities.map((c) => [c.capability, c.status])).toEqual([
      ["task-state", "passed"],
      ["briefs", "passed"],
      ["messages", "passed"],
    ]);
    const task = { homeId: adapter.installation.homeId, taskId: TaskId.parse("absent") };
    expect(await adapter.getFirstmateTask(task)).toMatchObject({
      attempt: null,
      activity: { state: "unknown", source: "none" },
      dependencies: { status: "unknown" },
    });
    const other = join(root, "other-home");
    await mkdir(other);
    expect(
      (await getFirstmateInstallation({ home: other, codeRoot: fixture.codeRoot })).homeId,
    ).not.toBe(adapter.installation.homeId);
    const script = join(fixture.codeRoot, "bin/fm-crew-state.sh");
    const original = await readFile(script, "utf8");
    await writeFile(script, "#!/bin/bash\necho unexpected-schema\n");
    await expect(adapter.getFirstmateTask(task)).rejects.toMatchObject({
      code: "firstmate.capability_held",
    });
    expect((await adapter.testFirstmateInstallation(["task-state"])).capabilities[0]?.status).toBe(
      "failed",
    );
    await writeFile(script, original);
    // Restoring exactly the verified fingerprint permits the prior evidence again.
    expect((await adapter.getFirstmateTask(task)).activity.state).toBe("unknown");
  } finally {
    adapter?.close();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240000);
