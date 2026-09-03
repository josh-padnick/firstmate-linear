import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { install, renderLaunchAgent, renderLinearAxiGuard, uninstall } from "./install.ts";
import { runInit } from "../commands/init.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("installer", () => {
  test("LaunchAgent embeds the selected home and one compiled service binary", () => {
    const plist = renderLaunchAgent("/opt/fm-linear", "/srv/firstmate", "/srv/firstmate/state/linear/service.log");
    expect(plist).toContain("/opt/fm-linear");
    expect(plist).toContain("/srv/firstmate");
    expect(plist).toContain("<string>service</string><string>run</string>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
  });

  test("the installed linear-axi shim permits reads and refuses writes", () => {
    const root = mkdtempSync("/private/tmp/fml-install-"); roots.push(root);
    const real = join(root, "real-linear-axi");
    const guard = join(root, "linear-axi");
    writeFileSync(real, "#!/bin/sh\nprintf 'real %s\\n' \"$*\"\n");
    writeFileSync(guard, renderLinearAxiGuard(real));
    chmodSync(real, 0o755); chmodSync(guard, 0o755);
    expect(spawnSync(guard, ["issue", "view", "ABC-1"], { encoding: "utf8" }).stdout).toContain("real issue view ABC-1");
    const denied = spawnSync(guard, ["issue", "update", "ABC-1", "--state", "Done"], { encoding: "utf8" });
    expect(denied.status).toBe(77);
    expect(denied.stderr).toContain("use fm-linear act");
  });

  test("uninstall then init preserves state and restores managed guidance", () => {
    const root = mkdtempSync("/private/tmp/fml-install-"); roots.push(root);
    const home = join(root, "home"); mkdirSync(home);
    const env = {
      FM_HOME: home,
      FM_LINEAR_INSTALL_ROOT: join(root, "runtime"),
      FM_LINEAR_LAUNCH_AGENTS_DIR: join(root, "agents"),
      FM_LINEAR_SKIP_LAUNCHCTL: "1",
      FM_LINEAR_REAL_LINEAR_AXI: "/usr/bin/true",
    };
    expect(runInit(["--captain", "Captain", "--team", "ABC"], env)).toBe(0);
    const database = join(home, "state", "linear", "fm-linear.db");
    const config = join(home, "config", "linear-workflow.yaml");
    install({ harnesses: ["claude"], bind: false, env });
    uninstall(env);
    expect(existsSync(database)).toBe(true);
    expect(existsSync(config)).toBe(true);
    expect(readFileSync(join(home, "data", "captain.md"), "utf8")).not.toContain("fm-linear:start");
    expect(runInit([], env)).toBe(0);
    expect(readFileSync(join(home, "data", "captain.md"), "utf8")).toContain("fm-linear:start");
  });
});
