import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshness, getFirstmateFleet, normalizeHome, primaryRoute } from "../src/firstmate/fleet";
import { FleetReader } from "../src/firstmate/fleet-reader";
import { FleetDocument, parseFleet } from "../src/firstmate/fleet-schema";
import { FleetStore } from "../src/firstmate/fleet-store";
import { RoutedHomeReader } from "../src/firstmate/routed-task";
import { AdapterStore } from "../src/firstmate/store";
import { Digest, type FirstmateInstallation, HomeId, TaskId } from "../src/firstmate/types";
import { hash } from "../src/support/files";

const time = "2026-09-10T12:00:00.000Z";
function document(home: string, codeRoot: string, generated = time) {
  return FleetDocument.parse({
    schema: "fm-fleet-snapshot.v1",
    generated,
    fm_home: home,
    roots: { fm_root: codeRoot },
    tasks: [
      {
        id: "same-task",
        kind: "scout",
        spawn_gen: "attempt-a",
        current_state: { state: "working", source: "pane", observed_at: generated },
      },
    ],
    backlog: {
      present: true,
      records: [{ structured: true, id: "queued", state: "queued", blocked_by_ids: ["same-task"] }],
    },
    secondmate_current: {
      registry: { available: true, complete: true, records: [] },
      records: [],
      truncated: 0,
    },
  });
}
function installation(home: string): FirstmateInstallation {
  return {
    homeId: HomeId.parse("home-primary"),
    home,
    codeRoot: "/code",
    commit: null,
    fingerprint: Digest.parse("0".repeat(64)),
    platform: process.platform,
  };
}

test("freshness rejects future clocks and missing dates, and old inventories cannot erase newer work", () => {
  const now = Date.parse(time);
  expect(freshness(null, now).freshness).toBe("unknown");
  expect(freshness(new Date(now + 1000).toISOString(), now).freshness).toBe("unknown");
  expect(freshness(time, now + 361000).freshness).toBe("stale");
  const route = primaryRoute(installation("/home"));
  const first = normalizeHome(document("/home", "/code"), route, time);
  expect(first.work.find((w) => w.kind === "backlog")?.dependencies?.[0]?.homeId).toBe(
    route.owner.homeId,
  );
  const older = document("/home", "/code", "2026-09-10T11:59:59.000Z");
  for (const task of older.tasks) task.current_state.state = "done";
  const second = normalizeHome(older, route, time, first);
  expect(second.work[1]?.activity.state).toBe("working");
  expect(second.reasons).toContain("out-of-order-evidence");
  const empty = document("/home", "/code");
  empty.tasks = [];
  const lost = normalizeHome(empty, route, time, first).work.find(
    (w) => w.task.taskId === "same-task",
  );
  expect(lost?.visibility).toBe("last-known");
  expect(lost?.activity.state).toBe("working");
  const future = document("/home", "/code", "2027-09-10T12:00:00.000Z");
  const untrusted = normalizeHome(future, route, time);
  const corrected = normalizeHome(document("/home", "/code"), route, time, untrusted);
  expect(corrected.work.find((w) => w.task.taskId === "same-task")?.visibility).toBe("current");
  expect(() => parseFleet(JSON.stringify({ ...empty, tasks: undefined }))).toThrow();
  expect(() =>
    parseFleet(JSON.stringify({ ...empty, tasks: [older.tasks[0], older.tasks[0]] })),
  ).toThrow();
});

test("SQLite upgrade preserves receipts; home identity survives restart, outages, and changed routes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fleet-store-")));
  const path = join(root, "adapter.sqlite");
  let store: AdapterStore | undefined;
  try {
    // Open a real version-1 database, rather than mocking the migration or storage calls.
    const old = new Database(path);
    old.exec(
      "CREATE TABLE records(home TEXT,kind TEXT,id TEXT,value TEXT,PRIMARY KEY(home,kind,id)); PRAGMA user_version=1;",
    );
    old
      .query("INSERT INTO records VALUES(?,?,?,?)")
      .run("home-primary", "brief", "receipt", '{"receiptId":"keep"}');
    old.close();
    store = new AdapterStore(path);
    expect(store.get<{ receiptId: string }>("home-primary", "brief", "receipt")).toEqual({
      receiptId: "keep",
    });
    const i = installation(root);
    let outage = false;
    let changed = false;
    const calls: string[] = [];
    const reader = () =>
      new FleetReader(i, async (_home, command, args) => {
        calls.push(command);
        if (command === "fm-on.sh" && outage)
          return { code: 255, stdout: "", stderr: "unreachable" };
        const doc = document(
          command === "fm-on.sh" ? "/child" : root,
          "/code",
          new Date().toISOString(),
        );
        if (command !== "fm-on.sh")
          doc.secondmate_current.registry.records = [
            {
              id: TaskId.parse("same-task"),
              home: changed ? "/replacement" : "/child",
              host: "remote",
              root: "/code",
              remote: true,
              registered: true,
              registry_error: null,
            },
          ];
        else expect(args.slice(0, 3)).toEqual(["same-task", "fm-fleet-snapshot.sh", "--json"]);
        return { code: 0, stdout: JSON.stringify(doc), stderr: "" };
      });
    const first = await getFirstmateFleet(i, store, {}, reader());
    const child = first.homes.find((h) => h.owner.secondmateId);
    expect(child?.work).toHaveLength(2);
    expect(child?.owner.homeId).not.toBe(i.homeId);
    store.close();
    store = new AdapterStore(path);
    outage = true;
    const offline = await getFirstmateFleet(i, store, {}, reader());
    const last = offline.homes.find((h) => h.owner.secondmateId);
    expect(last?.owner.homeId).toBe(child?.owner.homeId);
    expect(last?.coverage).toBe("unavailable");
    expect(last?.work.every((w) => w.visibility === "last-known")).toBe(true);
    const callsBeforeBackoff = calls.filter((c) => c === "fm-on.sh").length;
    await getFirstmateFleet(i, store, {}, reader());
    expect(calls.filter((c) => c === "fm-on.sh")).toHaveLength(callsBeforeBackoff);
    outage = false;
    const recovered = await getFirstmateFleet(i, store, { refresh: true }, reader());
    expect(recovered.homes.find((h) => h.owner.secondmateId)?.coverage).toBe("complete");
    expect(recovered.homes.find((h) => h.owner.secondmateId)?.owner.homeId).toBe(
      child?.owner.homeId,
    );
    changed = true;
    const held = await getFirstmateFleet(i, store, {}, reader());
    expect(held.homes.find((h) => h.owner.secondmateId)?.coverage).toBe("held");
    const heldHome = held.homes.find((h) => h.owner.secondmateId);
    if (!heldHome?.work[0]) throw new Error("Missing held fixture home");
    await mkdir(join(root, "data"));
    await writeFile(join(root, "data", "secondmates.md"), "changed registry");
    store.put(i.homeId, "fleet", "registry-revision", { revision: hash("changed registry") });
    await expect(
      new RoutedHomeReader(
        i,
        store,
        new FleetReader(i, async () => {
          throw new Error("A held route must not execute");
        }),
      ).readTask(heldHome.work[0].task),
    ).rejects.toMatchObject({ code: "firstmate.route_changed" });
    const persistence = new FleetStore(store, i.homeId);
    const lease = persistence.acquire(Date.now());
    expect(() => persistence.acquire(Date.now())).toThrow();
    persistence.release(lease);
    expect(new Set(calls)).toEqual(new Set(["fm-fleet-snapshot.sh", "fm-on.sh"]));
    expect(store.db.query<{ n: number }, []>("SELECT count(*) n FROM requests").get()?.n).toBe(0);
    // Unknown selectors remain incomplete; they never silently select the primary.
    expect(
      (await getFirstmateFleet(i, store, { secondmateIds: ["same-task."] }, reader())).coverage,
    ).toBe("partial");
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
