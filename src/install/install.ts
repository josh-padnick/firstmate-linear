import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveHome } from "../env.ts";
import { atomicWriteFile, ensurePrivateDir, lockAcquire, lockRelease, readText } from "../fsutil.ts";
import { runtimePaths } from "../paths.ts";
import { ASSETS } from "../assets.ts";

const LABEL = "com.firstmate.linear";
const CLAUDE_LINEAR_DENIES = ["Bash(linear-axi issue create:*)", "Bash(linear-axi issue update:*)", "Bash(linear-axi issue comment * --body:*)"] as const;

type ClaudeSettingsOwnership = {
  path: string;
  addedDenies: string[];
  previousOutputStyle: { present: boolean; value?: unknown };
};

type ExtensionOwnership = {
  packageRoot: string;
  bindOutput: string;
  registerOutput: string;
  bindingDigest: string | null;
  ownerToken: string | null;
};

type InstallRecord = {
  schema: "fm-linear.install.v1";
  binary?: string;
  linearAxiGuard?: string;
  plist?: string;
  extension?: ExtensionOwnership | null;
  harnesses?: string[];
  accelerators?: string[];
  claudeSettings?: ClaudeSettingsOwnership;
};

function repoRoot(): string { return join(dirname(fileURLToPath(import.meta.url)), "../.."); }
function uid(): string { return String(process.getuid?.() ?? 501); }

function installRoot(env: NodeJS.ProcessEnv): string {
  return env.FM_LINEAR_INSTALL_ROOT?.trim() || join(homedir(), ".local", "share", "fm-linear");
}

function agentsDir(env: NodeJS.ProcessEnv): string {
  return env.FM_LINEAR_LAUNCH_AGENTS_DIR?.trim() || join(homedir(), "Library", "LaunchAgents");
}

export function renderLaunchAgent(binary: string, home: string, log: string, runtimePath = process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"): string {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>KeepAlive</key><true/><key>RunAtLoad</key><true/>
<key>ProgramArguments</key><array><string>${escape(binary)}</string><string>service</string><string>run</string></array>
<key>EnvironmentVariables</key><dict><key>FM_HOME</key><string>${escape(home)}</string><key>PATH</key><string>${escape(runtimePath)}</string></dict>
<key>StandardOutPath</key><string>${escape(log)}</string>
<key>StandardErrorPath</key><string>${escape(log)}</string>
</dict></plist>
`;
}

function installBinary(root: string): string {
  const binary = join(root, "bin", "fm-linear");
  ensurePrivateDir(dirname(binary));
  if (basenameSafe(process.execPath) === "fm-linear") {
    if (process.execPath !== binary) copyFileSync(process.execPath, binary);
  } else {
    const result = spawnSync(process.execPath, ["build", join(repoRoot(), "src", "cli.ts"), "--compile", "--outfile", binary], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`binary build failed: ${result.stderr || result.stdout}`);
  }
  chmodSync(binary, 0o755);
  return binary;
}

function basenameSafe(path: string): string { return path.split("/").at(-1) ?? path; }

export function renderLinearAxiGuard(realBinary: string): string {
  const escaped = realBinary.replaceAll("'", `'\\''`);
  return `#!/bin/sh
set -eu
real='${escaped}'
case "\${1-} \${2-}" in
  " "|"--help "|"-h "|"--version "|"-V "|"issue list"|"issue view"|"team list"|"milestone list") exec "$real" "$@" ;;
  "issue comment")
    for arg in "$@"; do
      case "$arg" in --body|--body=*|--body-file|--body-file=*) echo "linear-axi: write refused; use fm-linear inbox show, then fm-linear act" >&2; exit 77 ;; esac
    done
    exec "$real" "$@"
    ;;
  *) echo "linear-axi: write or unknown command refused; use fm-linear act for Linear mutations" >&2; exit 77 ;;
esac
`;
}

function installLinearAxiGuard(root: string, env: NodeJS.ProcessEnv): string {
  const guard = join(root, "bin", "linear-axi");
  const explicit = env.FM_LINEAR_REAL_LINEAR_AXI?.trim();
  const located = spawnSync("which", ["-a", "linear-axi"], { encoding: "utf8", env: { ...process.env, ...env } });
  const candidates = located.status === 0 ? located.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : [];
  const real = explicit || candidates.find((item) => item !== guard);
  if (!real) throw new Error("linear-axi is required on PATH before installation");
  atomicWriteFile(guard, renderLinearAxiGuard(real), 0o755);
  return guard;
}

function outputField(output: string, name: string): string | null {
  return output.split(/\r?\n/).find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2).trim() || null;
}

function installExtension(root: string, env: NodeJS.ProcessEnv): ExtensionOwnership {
  const packageRoot = join(root, "extension", "1.0.0");
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  atomicWriteFile(join(packageRoot, "firstmate-extension.json"), ASSETS.extensionManifest, 0o644);
  atomicWriteFile(join(packageRoot, "bin", "fm-linear-extension"), ASSETS.extensionEntrypoint, 0o755);
  const home = resolveHome(env);
  const firstmateRoot = env.FM_ROOT_OVERRIDE?.trim() || home;
  const common = { encoding: "utf8" as const, env: { ...process.env, ...env, FM_HOME: home } };
  const bind = spawnSync(join(firstmateRoot, "bin", "fm-extension.sh"), ["bind", packageRoot, "--adapter", "linear", "--trust-same-user-code"], common);
  if (bind.status !== 0 && !`${bind.stderr}${bind.stdout}`.includes("already")) throw new Error(`extension bind failed: ${bind.stderr || bind.stdout}`);
  const bindOutput = `${bind.stdout}${bind.stderr}`.trim();
  const bindingDigest = outputField(bindOutput, "binding-digest");
  const register = spawnSync(join(firstmateRoot, "bin", "fm-procevent.sh"), ["register-extension", "linear", "linear-main", "--config-ref", runtimePaths(env).socket], common);
  if (register.status !== 0 && !`${register.stderr}${register.stdout}`.includes("already")) {
    if (bindingDigest) {
      spawnSync(join(firstmateRoot, "bin", "fm-extension.sh"), ["retire-binding", "dev.firstmate.linear", "--if-binding-digest", bindingDigest], common);
    }
    throw new Error(`source registration failed: ${register.stderr || register.stdout}`);
  }
  const registerOutput = `${register.stdout}${register.stderr}`.trim();
  return { packageRoot, bindOutput, registerOutput, bindingDigest, ownerToken: outputField(registerOutput, "owner-token") };
}

function installHarness(harness: string, home: string, priorClaudeSettings?: ClaudeSettingsOwnership): { files: string[]; claudeSettings?: ClaudeSettingsOwnership } {
  const installed: string[] = [];
  if (harness === "claude") {
    const command = join(home, ".claude", "commands", "report.md");
    const style = join(home, ".claude", "output-styles", "firstmate-linear.md");
    atomicWriteFile(command, "Run `fm-linear report` and relay its current findings to the captain.\n", 0o600);
    atomicWriteFile(style, ASSETS.outputStyle, 0o600);
    const settings = join(home, ".claude", "settings.local.json");
    let current: Record<string, any> = {};
    try { current = JSON.parse(readFileSync(settings, "utf8")); } catch { current = {}; }
    const ownership = priorClaudeSettings ?? {
      path: settings,
      addedDenies: CLAUDE_LINEAR_DENIES.filter((rule) => !current.permissions?.deny?.includes(rule)),
      previousOutputStyle: { present: Object.hasOwn(current, "outputStyle"), value: current.outputStyle },
    };
    const deny = new Set<string>(current.permissions?.deny ?? []);
    for (const rule of CLAUDE_LINEAR_DENIES) deny.add(rule);
    current.permissions = { ...(current.permissions ?? {}), deny: [...deny] };
    current.outputStyle = "firstmate-linear";
    atomicWriteFile(settings, `${JSON.stringify(current, null, 2)}\n`, 0o600);
    installed.push(command, style);
    return { files: installed, claudeSettings: ownership };
  } else if (harness === "codex") {
    const prompt = join(home, ".codex", "prompts", "report.md");
    atomicWriteFile(prompt, "Run `fm-linear report` and relay its current findings to the user.\n", 0o600);
    installed.push(prompt);
  } else if (harness !== "grok") {
    throw new Error(`unknown harness: ${harness}`);
  }
  return { files: installed };
}

export function install(options: { harnesses: string[]; bind: boolean; env?: NodeJS.ProcessEnv }): { binary: string; plist: string } {
  const env = options.env ?? process.env;
  const home = resolveHome(env);
  const root = installRoot(env);
  ensurePrivateDir(root);
  const binary = installBinary(root);
  const linearAxiGuard = installLinearAxiGuard(root, env);
  const paths = runtimePaths(env);
  ensurePrivateDir(paths.root);
  let prior: InstallRecord | undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(paths.root, "install.json"), "utf8")) as InstallRecord;
    if (parsed.schema === "fm-linear.install.v1") prior = parsed;
  } catch { /* first installation */ }
  const plist = join(agentsDir(env), `${LABEL}.plist`);
  mkdirSync(dirname(plist), { recursive: true });
  atomicWriteFile(plist, renderLaunchAgent(binary, home, paths.serviceLog, env.PATH || process.env.PATH), 0o644);
  const installedExtension = options.bind ? installExtension(root, env) : null;
  const extension = installedExtension ? {
    ...installedExtension,
    bindingDigest: installedExtension.bindingDigest ?? prior?.extension?.bindingDigest ?? null,
    ownerToken: installedExtension.ownerToken ?? prior?.extension?.ownerToken ?? null,
  } : prior?.extension ?? null;
  const harnessResults = options.harnesses.map((harness) => installHarness(harness, home, prior?.claudeSettings));
  const accelerators = [...new Set([...(prior?.accelerators ?? []), ...harnessResults.flatMap((result) => result.files)])];
  const harnesses = [...new Set([...(prior?.harnesses ?? []), ...options.harnesses])];
  const claudeSettings = harnessResults.find((result) => result.claudeSettings)?.claudeSettings ?? prior?.claudeSettings;
  atomicWriteFile(join(paths.root, "install.json"), `${JSON.stringify({ schema: "fm-linear.install.v1", binary, linearAxiGuard, plist, extension, harnesses, accelerators, claudeSettings }, null, 2)}\n`);
  if (!env.FM_LINEAR_SKIP_LAUNCHCTL) {
    spawnSync("launchctl", ["bootout", `gui/${uid()}/${LABEL}`], { encoding: "utf8" });
    const result = spawnSync("launchctl", ["bootstrap", `gui/${uid()}`, plist], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`launchctl bootstrap failed: ${result.stderr || result.stdout}`);
  }
  return { binary, plist };
}

export function uninstall(env: NodeJS.ProcessEnv = process.env): void {
  const paths = runtimePaths(env);
  if (!env.FM_LINEAR_SKIP_LAUNCHCTL) spawnSync("launchctl", ["bootout", `gui/${uid()}/${LABEL}`], { encoding: "utf8" });
  const record = readText(join(paths.root, "install.json"));
  if (record) {
    let parsed: { schema?: string; binary?: string; linearAxiGuard?: string; plist?: string; extension?: { packageRoot?: string; bindingDigest?: string | null; ownerToken?: string | null }; accelerators?: string[]; claudeSettings?: ClaudeSettingsOwnership } | null = null;
    try { parsed = JSON.parse(record); } catch { parsed = null; }
    if (parsed?.schema === "fm-linear.install.v1") {
      const home = resolveHome(env);
      const firstmateRoot = env.FM_ROOT_OVERRIDE?.trim() || home;
      const common = { encoding: "utf8" as const, env: { ...process.env, ...env, FM_HOME: home } };
      if (parsed.extension?.ownerToken) {
        const retire = spawnSync(join(firstmateRoot, "bin", "fm-procevent.sh"), ["retire", "linear-main", "--if-owner", parsed.extension.ownerToken], common);
        if (retire.status !== 0) throw new Error(`source retirement failed: ${retire.stderr || retire.stdout}`);
      }
      if (parsed.extension?.bindingDigest) {
        const retire = spawnSync(join(firstmateRoot, "bin", "fm-extension.sh"), ["retire-binding", "dev.firstmate.linear", "--if-binding-digest", parsed.extension.bindingDigest], common);
        if (retire.status !== 0) throw new Error(`extension retirement failed: ${retire.stderr || retire.stdout}`);
      }
      if (parsed.plist) rmSync(parsed.plist, { force: true });
      for (const file of parsed.accelerators ?? []) rmSync(file, { force: true });
      if (parsed.binary) rmSync(parsed.binary, { force: true });
      if (parsed.linearAxiGuard) rmSync(parsed.linearAxiGuard, { force: true });
      if (parsed.extension?.packageRoot) rmSync(parsed.extension.packageRoot, { recursive: true, force: true });
      if (parsed.claudeSettings) {
        try {
          const settings = JSON.parse(readFileSync(parsed.claudeSettings.path, "utf8")) as Record<string, any>;
          if (Array.isArray(settings.permissions?.deny)) {
            const added = new Set(parsed.claudeSettings.addedDenies);
            settings.permissions.deny = settings.permissions.deny.filter((rule: unknown) => typeof rule !== "string" || !added.has(rule));
            if (settings.permissions.deny.length === 0) delete settings.permissions.deny;
          }
          if (settings.outputStyle === "firstmate-linear") {
            if (parsed.claudeSettings.previousOutputStyle.present) settings.outputStyle = parsed.claudeSettings.previousOutputStyle.value;
            else delete settings.outputStyle;
          }
          atomicWriteFile(parsed.claudeSettings.path, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
        } catch { /* no managed Claude settings */ }
      }
      rmSync(join(paths.root, "install.json"), { force: true });
    }
  }
  const captainPath = join(resolveHome(env), "data", "captain.md");
  try {
    const text = readFileSync(captainPath, "utf8");
    const updated = text.replace(/\n?<!-- fm-linear:start -->[\s\S]*?<!-- fm-linear:end -->\n?/, "\n").trimEnd();
    atomicWriteFile(captainPath, updated ? `${updated}\n` : "", 0o600);
  } catch { /* absent captain guidance */ }
}

export function cutover(mode: "enable" | "disable", env: NodeJS.ProcessEnv = process.env): void {
  const home = resolveHome(env);
  const lock = join(home, "state", "linear-cutover.lock");
  const acquired = lockAcquire(lock);
  if (acquired !== "ok") throw new Error(`cutover lease ${acquired}`);
  try {
    atomicWriteFile(join(home, "config", "linear-cutover"), `${mode === "enable" ? "service" : "legacy"}\n`);
    if (!env.FM_LINEAR_SKIP_LAUNCHCTL) {
      const action = mode === "enable" ? "kickstart" : "kill";
      const args = action === "kickstart" ? [action, "-k", `gui/${uid()}/${LABEL}`] : [action, "SIGTERM", `gui/${uid()}/${LABEL}`];
      spawnSync("launchctl", args, { encoding: "utf8" });
    }
  } finally { lockRelease(lock); }
}
