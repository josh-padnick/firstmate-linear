import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockAcquire, lockRelease } from "./fsutil.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("singleton lease", () => {
  test("repeated starts admit exactly one holder", () => {
    const root = mkdtempSync("/private/tmp/fml-lock-"); roots.push(root);
    const lock = join(root, "service.lock");
    expect(lockAcquire(lock)).toBe("ok");
    for (let attempt = 0; attempt < 5; attempt += 1) expect(lockAcquire(lock)).toBe("busy");
    lockRelease(lock);
    expect(lockAcquire(lock)).toBe("ok");
    lockRelease(lock);
  });

  test("a dead owner is recovered", () => {
    const root = mkdtempSync("/private/tmp/fml-lock-"); roots.push(root);
    const lock = join(root, "service.lock"); mkdirSync(lock);
    writeFileSync(join(lock, "pid"), "99999999\n");
    expect(lockAcquire(lock)).toBe("ok");
    lockRelease(lock);
  });
});
