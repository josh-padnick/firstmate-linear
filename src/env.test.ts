import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envGet, loadKey, resolveHome, resolveStateDir } from "./env.ts";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("env", () => {
  test("resolveHome requires FM_HOME", () => {
    expect(() => resolveHome({})).toThrow("FM_HOME is required");
    expect(resolveHome({ FM_HOME: "/tmp/home" })).toBe("/tmp/home");
  });

  test("resolveStateDir honors FM_STATE_OVERRIDE", () => {
    expect(resolveStateDir("/tmp/home", {})).toBe("/tmp/home/state");
    expect(resolveStateDir("/tmp/home", { FM_STATE_OVERRIDE: "/tmp/state" })).toBe("/tmp/state");
  });

  test("envGet ports export, quotes, and last-assignment-wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-linear-env-"));
    temps.push(dir);
    const file = join(dir, ".env");
    writeFileSync(
      file,
      [
        "LINEAR_API_KEY=first",
        "export LINEAR_API_KEY=second",
        `LINEAR_API_KEY="quoted"`,
        "OTHER=1",
      ].join("\n"),
    );
    expect(envGet("LINEAR_API_KEY", file)).toBe("quoted");
    expect(envGet("OTHER", file)).toBe("1");
    expect(envGet("MISSING", file)).toBe("");
  });

  test("loadKey prefers the process environment over .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-linear-env-"));
    temps.push(dir);
    writeFileSync(join(dir, ".env"), "LINEAR_API_KEY=from-file\n");
    expect(loadKey(dir, { LINEAR_API_KEY: "from-env" })).toBe("from-env");
    expect(loadKey(dir, {})).toBe("from-file");
    expect(() => loadKey(dir + "-missing", {})).toThrow("missing LINEAR_API_KEY");
  });
});
