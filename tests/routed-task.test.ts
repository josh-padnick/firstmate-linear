import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instructionBlock } from "../src/firstmate/briefs";
import { childRoute, normalizeHome } from "../src/firstmate/fleet";
import { FleetReader } from "../src/firstmate/fleet-reader";
import { FleetDocument } from "../src/firstmate/fleet-schema";
import { FleetStore } from "../src/firstmate/fleet-store";
import { RoutedHomeReader } from "../src/firstmate/routed-task";
import { AdapterStore } from "../src/firstmate/store";
import { AttemptId, type FirstmateInstallation, HomeId, TaskId } from "../src/firstmate/types";
import { hash } from "../src/support/files";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(kind: "local" | "remote") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "routed-read-")));
  const child = join(root, "child");
  await mkdir(join(root, "data"));
  await mkdir(join(child, "data", "task"), { recursive: true });
  await mkdir(join(child, "state"));
  const registry = join(root, "data", "secondmates.md");
  await writeFile(registry, "original registry");
  const installation: FirstmateInstallation = {
    homeId: HomeId.parse("primary"),
    home: root,
    codeRoot: "/code",
    commit: null,
    fingerprint: hash("fixture"),
    platform: process.platform,
  };
  const store = new AdapterStore(join(root, "state.sqlite"));
  cleanup.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const persistence = new FleetStore(store, installation.homeId);
  const route = persistence.bind(
    childRoute(installation, {
      id: TaskId.parse("child"),
      home: child,
      root: "/code",
      host: kind === "remote" ? "host" : null,
      remote: kind === "remote",
      registered: true,
      registry_error: null,
    }),
  );
  const task = { homeId: route.owner.homeId, taskId: TaskId.parse("task") };
  const attempt = { task, attemptId: AttemptId.parse("attempt-a") };
  const content = instructionBlock("Include the review recap.", "v1");
  await writeFile(join(child, "state/task.meta"), "spawn_gen=attempt-a\n");
  await writeFile(join(child, "data/task/brief.md"), content);
  await writeFile(join(child, "data/task/launch-brief.md"), content);
  const receipt = {
    receiptId: crypto.randomUUID(),
    task,
    previousRevision: hash(""),
    revision: hash(content),
    instructionVersion: "v1",
    instructionDigest: hash(content),
    updatedAt: new Date().toISOString(),
  };
  const acceptRevision = (
    primary = installation.homeId,
    revision: string | null = hash("original registry"),
  ) => store.put(primary, "fleet", "registry-revision", { revision });
  acceptRevision();
  let commands = 0;
  let changeDuringRead = false;
  // Keep SQLite and local file reads real; control the external command and registry observations.
  class Reader extends FleetReader {
    private registryReads = 0;
    override async registryRevision() {
      if (++this.registryReads === 2 && changeDuringRead)
        await writeFile(registry, "changed registry");
      return super.registryRevision();
    }
  }
  const routed = (primary = installation) =>
    new RoutedHomeReader(
      primary,
      store,
      new Reader(primary, async (_home, command, args) => {
        commands++;
        const script = command === "fm-on.sh" ? args[1] : command;
        const path = command === "fm-on.sh" ? args[3] : args[1];
        return {
          code: 0,
          stderr: "",
          stdout:
            script === "fm-crew-state.sh"
              ? "state: working · source: pane\n"
              : path?.endsWith(".meta")
                ? "spawn_gen=attempt-a\n"
                : content,
        };
      }),
    );
  const hold = () => {
    const now = new Date().toISOString();
    const observation = normalizeHome(
      FleetDocument.parse({
        schema: "fm-fleet-snapshot.v1",
        generated: now,
        fm_home: child,
        roots: { fm_root: "/code" },
        tasks: [],
        backlog: { present: true, records: [] },
        secondmate_current: {
          registry: { available: true, complete: true, records: [] },
          records: [],
          truncated: 0,
        },
      }),
      route,
      now,
    );
    const lease = persistence.acquire(Date.now());
    try {
      persistence.save(
        [{ ...observation, coverage: "held" }],
        lease,
        Date.now(),
        hash("original registry"),
      );
    } finally {
      persistence.release(lease);
    }
  };
  return {
    installation,
    task,
    attempt,
    receipt,
    routed,
    acceptRevision,
    hold,
    commands: () => commands,
    changeDuringRead: () => {
      changeDuringRead = true;
    },
  };
}

for (const kind of ["local", "remote"] as const) {
  test(`${kind} task and brief reads share verified home identity and evidence`, async () => {
    const f = await fixture(kind);
    expect(await f.routed().readTask(f.task)).toMatchObject({
      task: f.task,
      presence: "found",
      attempt: f.attempt,
      activity: { state: "working" },
    });
    expect(await f.routed().checkBrief(f.receipt, f.attempt)).toMatchObject({
      attempt: f.attempt,
      status: "included",
      reason: "matched",
      launchRevision: f.receipt.revision,
    });
    const other = { ...f.installation, homeId: HomeId.parse("other-primary") };
    await expect(f.routed(other).readTask(f.task)).rejects.toMatchObject({
      code: "firstmate.scope_mismatch",
    });
    await expect(f.routed(other).checkBrief(f.receipt, f.attempt)).rejects.toMatchObject({
      code: "firstmate.scope_mismatch",
    });
    await expect(
      f
        .routed()
        .checkBrief(
          { ...f.receipt, task: { ...f.task, taskId: TaskId.parse("other") } },
          f.attempt,
        ),
    ).rejects.toMatchObject({ code: "firstmate.scope_mismatch" });
  });

  test(`${kind} task and brief reads refuse missing, stale, foreign, and held route evidence`, async () => {
    const f = await fixture(kind);
    for (const revision of [null, hash("stale registry")]) {
      f.acceptRevision(f.installation.homeId, revision);
      // A matching revision saved for another primary cannot authorize this home.
      f.acceptRevision(HomeId.parse("other-primary"));
      await expect(f.routed().readTask(f.task)).rejects.toMatchObject({
        code: "firstmate.route_changed",
      });
      await expect(f.routed().checkBrief(f.receipt, f.attempt)).rejects.toMatchObject({
        code: "firstmate.route_changed",
      });
    }
    f.hold();
    await expect(f.routed().readTask(f.task)).rejects.toMatchObject({
      code: "firstmate.route_changed",
    });
    await expect(f.routed().checkBrief(f.receipt, f.attempt)).rejects.toMatchObject({
      code: "firstmate.route_changed",
    });
    expect(f.commands()).toBe(0);
  });

  test(`${kind} registry changes discard task results and invalidate brief inclusion`, async () => {
    const task = await fixture(kind);
    task.changeDuringRead();
    await expect(task.routed().readTask(task.task)).rejects.toMatchObject({
      code: "firstmate.route_changed",
    });
    const brief = await fixture(kind);
    brief.changeDuringRead();
    expect(await brief.routed().checkBrief(brief.receipt, brief.attempt)).toMatchObject({
      attempt: brief.attempt,
      status: "not-verified",
      reason: "attempt-changed",
      launchRevision: null,
    });
  });
}
