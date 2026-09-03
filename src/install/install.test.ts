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
    const settings = join(home, ".claude", "settings.local.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settings, `${JSON.stringify({ permissions: { deny: ["Bash(linear-axi issue create:*)", "Bash(git push:*)"] }, outputStyle: "concise" })}\n`);
    const existingReport = join(home, ".claude", "commands", "report.md");
    mkdirSync(join(home, ".claude", "commands"), { recursive: true });
    writeFileSync(existingReport, "User-owned report command\n");
    install({ harnesses: ["claude"], bind: false, env });
    const installRecord = join(home, "state", "linear", "install.json");
    const extensionRoot = join(root, "runtime", "extension", "prior");
    mkdirSync(extensionRoot, { recursive: true });
    const prior = JSON.parse(readFileSync(installRecord, "utf8"));
    prior.extension = { packageRoot: extensionRoot, bindOutput: "", registerOutput: "", bindingDigest: null, ownerToken: null };
    writeFileSync(installRecord, `${JSON.stringify(prior)}\n`);
    install({ harnesses: ["codex"], bind: false, env });
    uninstall(env);
    expect(existsSync(database)).toBe(true);
    expect(existsSync(config)).toBe(true);
    expect(readFileSync(join(home, "data", "captain.md"), "utf8")).not.toContain("fm-linear:start");
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { deny: ["Bash(linear-axi issue create:*)", "Bash(git push:*)"] }, outputStyle: "concise" });
    expect(readFileSync(existingReport, "utf8")).toBe("User-owned report command\n");
    expect(existsSync(join(home, ".codex", "prompts", "report.md"))).toBe(false);
    expect(existsSync(extensionRoot)).toBe(false);
    expect(runInit([], env)).toBe(0);
    expect(readFileSync(join(home, "data", "captain.md"), "utf8")).toContain("fm-linear:start");
  });

  test("uninstall leaves Claude settings unchanged without a valid install record", () => {
    const root = mkdtempSync("/private/tmp/fml-install-"); roots.push(root);
    const home = join(root, "home");
    const settings = join(home, ".claude", "settings.local.json");
    const installRecord = join(home, "state", "linear", "install.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, "state", "linear"), { recursive: true });
    const original = { permissions: { deny: ["Bash(linear-axi issue update:*)"] }, outputStyle: "firstmate-linear" };
    writeFileSync(settings, `${JSON.stringify(original)}\n`);
    writeFileSync(installRecord, "{not-json\n");
    uninstall({ FM_HOME: home, FM_LINEAR_SKIP_LAUNCHCTL: "1" });
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(original);
  });

  test("legacy managed accelerators remain removable after reinstall", () => {
    const root = mkdtempSync("/private/tmp/fml-install-"); roots.push(root);
    const home = join(root, "home"); mkdirSync(home);
    const env = {
      FM_HOME: home,
      FM_LINEAR_INSTALL_ROOT: join(root, "runtime"),
      FM_LINEAR_LAUNCH_AGENTS_DIR: join(root, "agents"),
      FM_LINEAR_SKIP_LAUNCHCTL: "1",
      FM_LINEAR_REAL_LINEAR_AXI: "/usr/bin/true",
    };
    install({ harnesses: ["codex"], bind: false, env });
    const installRecord = join(home, "state", "linear", "install.json");
    const legacy = JSON.parse(readFileSync(installRecord, "utf8"));
    delete legacy.ownedFiles;
    writeFileSync(installRecord, `${JSON.stringify(legacy)}\n`);
    const accelerator = join(home, ".codex", "prompts", "report.md");
    expect(existsSync(accelerator)).toBe(true);
    install({ harnesses: ["codex"], bind: false, env });
    uninstall(env);
    expect(existsSync(accelerator)).toBe(false);
  });

  test("Claude installation refuses malformed user settings without rewriting them", () => {
    const root = mkdtempSync("/private/tmp/fml-install-"); roots.push(root);
    const home = join(root, "home");
    const settings = join(home, ".claude", "settings.local.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settings, "{user-owned-invalid-json\n");
    const env = {
      FM_HOME: home,
      FM_LINEAR_INSTALL_ROOT: join(root, "runtime"),
      FM_LINEAR_LAUNCH_AGENTS_DIR: join(root, "agents"),
      FM_LINEAR_SKIP_LAUNCHCTL: "1",
      FM_LINEAR_REAL_LINEAR_AXI: "/usr/bin/true",
    };
    expect(() => install({ harnesses: ["claude"], bind: false, env })).toThrow("refusing to overwrite malformed Claude settings");
    expect(readFileSync(settings, "utf8")).toBe("{user-owned-invalid-json\n");
    expect(existsSync(join(home, ".claude", "commands", "report.md"))).toBe(false);
  });
});
