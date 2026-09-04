import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runInstall } from "./install.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("install command", () => {
  test("missing and flag-shaped harness values fail before installation", () => {
    for (const args of [["--harness"], ["--harness", "--no-bind"]]) {
      const root = mkdtempSync("/private/tmp/fml-install-command-"); roots.push(root);
      const home = join(root, "home");
      const runtime = join(root, "runtime");
      const agents = join(root, "agents");
      const env = {
        FM_HOME: home,
        FM_LINEAR_INSTALL_ROOT: runtime,
        FM_LINEAR_LAUNCH_AGENTS_DIR: agents,
        FM_LINEAR_SKIP_LAUNCHCTL: "1",
        FM_LINEAR_REAL_LINEAR_AXI: "/usr/bin/true",
      };
      expect(runInstall(args, env)).toBe(2);
      expect(existsSync(runtime)).toBe(false);
      expect(existsSync(agents)).toBe(false);
      expect(existsSync(join(home, "state", "linear", "install.json"))).toBe(false);
    }
  });
});
