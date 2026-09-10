import { expect, test } from "bun:test";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { fleetProbe } from "../src/firstmate/fleet-probe";
import { IsolatedFirstmate } from "../src/firstmate/isolation";
import { AdapterStore } from "../src/firstmate/store";
import type { FirstmateInstallation } from "../src/firstmate/types";

test("the real full snapshot and registered route retain more tasks than a summary can show", async () => {
  const source = process.env.FIRSTMATE_SOURCE;
  if (!source) throw new Error("Set FIRSTMATE_SOURCE to the upstream checkout.");
  const fixture = await IsolatedFirstmate.create(source);
  try {
    const doc = await fleetProbe(fixture, true);
    expect(doc.tasks).toHaveLength(25);
    expect(String(doc.tasks.find((t) => t.id === "child-24")?.spawn_gen)).toBe("attempt-24");
    // Process wiring: the compiled CLI selects the child home and keeps its task identity.
    const binary = join(fixture.root, "fm-linear");
    await cp(join(process.cwd(), ".build/fm-linear"), binary);
    const state = join(fixture.root, "cli-state", "state.sqlite");
    const args = [
      "--home",
      fixture.home,
      "--code-root",
      fixture.codeRoot,
      "--state",
      state,
      "--json",
    ];
    const installed = await fixture.run(binary, ["installation", ...args]);
    expect(installed.code).toBe(0);
    const installation = JSON.parse(installed.stdout) as FirstmateInstallation;
    const store = new AdapterStore(state);
    try {
      store.put(installation.homeId, "compatibility", installation.fingerprint, {
        schemaVersion: 1,
        checkId: crypto.randomUUID(),
        installation,
        adapterVersion: "0.1.0",
        suiteVersion: "3",
        checkedAt: new Date().toISOString(),
        capabilities: ["fleet", "routed-reads"].map((capability) => ({
          capability,
          status: "passed",
          evidence: ["Real fleet and route probe completed immediately above."],
        })),
      });
    } finally {
      store.close();
    }
    const result = await fixture.run(
      binary,
      ["task", "child-24", "--secondmate", "probe-child", ...args],
      {},
      60000,
    );
    expect(result.code).toBe(0);
    const task = JSON.parse(result.stdout);
    expect(task.task.taskId).toBe("child-24");
    expect(task.task.homeId).not.toBe(installation.homeId);
    expect(task.presence).toBe("found");
    expect(task.attempt.attemptId).toBe("attempt-24");
  } finally {
    await fixture.close();
  }
}, 240000);
