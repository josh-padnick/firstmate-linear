import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBrief, editBrief, instructionBlock, updateBrief } from "../src/firstmate/briefs";
import { AdapterStore } from "../src/firstmate/store";
import { AttemptId, type FirstmateInstallation, HomeId, TaskId } from "../src/firstmate/types";
import { hash } from "../src/support/files";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const original =
  "# Task\n\n## Captain's intent\nKeep this exactly.\n\n## Firstmate spec\nBuild invitations.\n\n## Other\nKeep this too.\n";
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fm-unit-")));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(join(home, "data", "task"), { recursive: true });
  await mkdir(join(home, "state"));
  await writeFile(join(home, "data/task/brief.md"), original);
  const installation: FirstmateInstallation = {
    homeId: HomeId.parse("home-one"),
    home,
    codeRoot: root,
    commit: null,
    fingerprint: hash("fixture"),
    platform: process.platform,
  };
  const task = { homeId: installation.homeId, taskId: TaskId.parse("task") };
  return {
    root,
    home,
    installation,
    task,
    path: join(home, "data/task/brief.md"),
    database: join(root, "private", "state.sqlite"),
  };
}
test("managed text replaces only its section and rejects ambiguous markers", () => {
  const block = instructionBlock("Create a recap.", "v1");
  const once = editBrief(original, block);
  expect(editBrief(once, block)).toBe(once);
  expect(once).toContain("## Captain's intent\nKeep this exactly.");
  expect(once).toEndWith("## Other\nKeep this too.\n");
  expect(() => editBrief(original + block, block)).toThrow();
  expect(() => editBrief(`${original}\n## Firstmate spec\n`, block)).toThrow();
});
test("brief retries survive reopen, reject stale edits, and recover an interrupted receipt commit", async () => {
  const f = await fixture();
  let store = new AdapterStore(f.database);
  try {
    const request = {
      task: f.task,
      expectedRevision: hash(original),
      instructions: { text: "Create an interactive recap.", version: "v1" },
    };
    const receipt = await updateBrief(f.installation, store, request);
    store.close();
    store = new AdapterStore(f.database, { existing: true });
    expect(await updateBrief(f.installation, store, request)).toEqual(receipt);
    store.db.query("DELETE FROM records WHERE kind='brief'").run();
    expect(await updateBrief(f.installation, store, request)).toEqual(receipt);
    await writeFile(f.path, `${await readFile(f.path, "utf8")}Human edit\n`);
    await expect(updateBrief(f.installation, store, request)).rejects.toMatchObject({
      code: "firstmate.stale_brief",
    });
  } finally {
    store.close();
  }
});
test("a missing or stale launch never becomes confirmed instruction delivery", async () => {
  const f = await fixture();
  const store = new AdapterStore(f.database);
  try {
    const receipt = await updateBrief(f.installation, store, {
      task: f.task,
      expectedRevision: hash(original),
      instructions: { text: "Recap", version: "v1" },
    });
    const attempt = { task: f.task, attemptId: AttemptId.parse("s1") };
    expect((await checkBrief(f.installation, receipt, attempt)).status).toBe("not-verified");
    await writeFile(join(f.home, "state/task.meta"), "spawn_gen=s1\n");
    await writeFile(join(f.home, "data/task/launch-brief.md"), original);
    expect((await checkBrief(f.installation, receipt, attempt)).status).toBe("missing");
    await writeFile(join(f.home, "data/task/launch-brief.md"), await readFile(f.path));
    expect((await checkBrief(f.installation, receipt, attempt)).status).toBe("included");
    await writeFile(join(f.home, "state/task.meta"), "spawn_gen=s2\n");
    expect((await checkBrief(f.installation, receipt, attempt)).status).toBe("not-verified");
  } finally {
    store.close();
  }
});
test("home mismatch and linked files cannot redirect a brief update", async () => {
  const f = await fixture();
  const store = new AdapterStore(f.database);
  try {
    const request = {
      task: f.task,
      expectedRevision: hash(original),
      instructions: { text: "Recap", version: "v1" },
    };
    await expect(
      updateBrief(f.installation, store, {
        ...request,
        task: { ...f.task, homeId: HomeId.parse("other") },
      }),
    ).rejects.toMatchObject({ code: "firstmate.scope_mismatch" });
    await rm(f.path);
    await writeFile(join(f.root, "outside"), original);
    await symlink(join(f.root, "outside"), f.path);
    await expect(updateBrief(f.installation, store, request)).rejects.toMatchObject({
      code: "firstmate.contract_failed",
    });
    expect(await readFile(join(f.root, "outside"), "utf8")).toBe(original);
  } finally {
    store.close();
  }
});
