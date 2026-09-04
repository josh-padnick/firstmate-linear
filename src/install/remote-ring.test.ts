import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { renderRemoteRingCheck } from "./remote-ring.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("remote ring is a silent registered check until an inbox record ages out", () => {
  const home = mkdtempSync("/private/tmp/fml-ring-"); roots.push(home);
  const inbox = join(home, "state", "worker.inbox"); mkdirSync(inbox, { recursive: true });
  const record = join(inbox, "001.msg"); writeFileSync(record, "pending\n");
  const script = renderRemoteRingCheck(180);
  expect(spawnSync("sh", ["-c", script], { encoding: "utf8", env: { ...process.env, FM_HOME: home } }).stdout).toBe("");
  const expired = new Date(Date.now() - 181_000); utimesSync(record, expired, expired);
  const result = spawnSync("sh", ["-c", script], { encoding: "utf8", env: { ...process.env, FM_HOME: home } });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("fm-linear: unhandled inbox record older than 180s");
});
