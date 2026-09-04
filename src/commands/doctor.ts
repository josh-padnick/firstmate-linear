import { spawnSync } from "node:child_process";
import { resolveHome, tryLoadKey } from "../env.ts";
import { assertParseRoundTrip } from "../time.ts";
import { LinearTransport } from "../transport.ts";
import { existsSync, readFileSync } from "node:fs";
import { configPath, loadConfig, loadConfigFile } from "../config/load.ts";
import { StateDatabase } from "../db/database.ts";
import { runtimePaths } from "../paths.ts";
import { configuredRemoteHosts } from "../reconcile/host.ts";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
};

function bunPresent(): DoctorCheck {
  const result = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (result.status === 0) {
    return {
      name: "bun",
      ok: true,
      detail: (result.stdout || "").trim() || "present",
      required: false,
    };
  }
  return { name: "bun", ok: false, detail: "not needed by the installed binary; required only for source builds", required: false };
}

function nodePresent(): DoctorCheck {
  const result = spawnSync("node", ["--version"], { encoding: "utf8" });
  if (result.status === 0) {
    return { name: "node", ok: true, detail: (result.stdout || "").trim() || "present", required: true };
  }
  return { name: "node", ok: false, detail: "Node.js is required by the Firstmate extension entrypoint", required: true };
}

function keyPresent(env: NodeJS.ProcessEnv): DoctorCheck {
  try {
    const home = resolveHome(env);
    const key = tryLoadKey(home, env);
    if (key) {
      return { name: "key", ok: true, detail: `present (${key.length} chars)`, required: true };
    }
    return { name: "key", ok: false, detail: `missing LINEAR_API_KEY in the macOS Keychain and ${home}/.env`, required: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "key", ok: false, detail: message, required: true };
  }
}

function parseRoundTrip(): DoctorCheck {
  try {
    assertParseRoundTrip();
    return {
      name: "parse-round-trip",
      ok: true,
      detail: "parse(format(epoch)) === epoch (UTC, Phoenix, New York DST epochs)",
      required: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "parse-round-trip", ok: false, detail: message, required: true };
  }
}

function configValid(env: NodeJS.ProcessEnv): DoctorCheck {
  try {
    const activePath = configPath(env);
    try { loadConfigFile(activePath); }
    catch (activeError) {
      const config = loadConfig(env);
      return { name: "config", ok: true, detail: `using last-known-good because current config is invalid: ${activeError instanceof Error ? activeError.message : String(activeError)}; teams=${config.teams.map((team) => team.key).join(",")}`, required: true };
    }
    const config = loadConfig(env);
    return { name: "config", ok: true, detail: `${config.teams.length} team(s), managed=${config.teams.map((team) => `${team.key}:${team.managed}`).join(",")}`, required: true };
  } catch (error) {
    return { name: "config", ok: false, detail: error instanceof Error ? error.message : String(error), required: true };
  }
}

function databaseValid(env: NodeJS.ProcessEnv): DoctorCheck {
  try {
    const db = StateDatabase.open(env);
    const row = db.raw.query("PRAGMA integrity_check").get() as { integrity_check?: string } | null;
    db.close();
    const ok = row?.integrity_check === "ok";
    return { name: "database", ok, detail: ok ? "schema current; integrity ok; WAL enabled" : JSON.stringify(row), required: true };
  } catch (error) {
    return { name: "database", ok: false, detail: error instanceof Error ? error.message : String(error), required: true };
  }
}

function remoteRings(env: NodeJS.ProcessEnv): DoctorCheck {
  try {
    const home = resolveHome(env);
    const hosts = configuredRemoteHosts(home);
    if (!hosts.length) {
      return { name: "remote-rings", ok: true, detail: "no configured remote homes", required: false };
    }
    const db = StateDatabase.open(env);
    const rows = db.raw.query("SELECT home,installed_at,last_error FROM remote_rings").all() as Array<{ home: string; installed_at: string | null; last_error: string | null }>;
    db.close();
    const byHome = new Map(rows.map((row) => [row.home, row]));
    const failures = hosts.filter((host) => !byHome.get(host)?.installed_at || byHome.get(host)?.last_error);
    if (failures.length) return { name: "remote-rings", ok: false, detail: `${failures.map((host) => `${host}: ${byHome.get(host)?.last_error ?? "not installed"}`).join("; ")}; run fm-linear install --remote-ring <home>`, required: false };
    return { name: "remote-rings", ok: true, detail: `installed for ${hosts.join(",")}`, required: false };
  } catch (error) {
    return { name: "remote-rings", ok: false, detail: error instanceof Error ? error.message : String(error), required: false };
  }
}

function installation(env: NodeJS.ProcessEnv): DoctorCheck {
  try {
    const path = `${runtimePaths(env).root}/install.json`;
    if (!existsSync(path)) return { name: "install", ok: false, detail: "not installed; run fm-linear install --harness <name>", required: false };
    const record = JSON.parse(readFileSync(path, "utf8")) as {
      binary?: string;
      linearAxiGuard?: string;
      plist?: string;
      extension?: { packageRoot?: string; bindingDigest?: string | null; ownerToken?: string | null } | null;
      harnesses?: string[];
    };
    const artifacts = [record.binary, record.linearAxiGuard, record.plist, record.extension?.packageRoot]
      .filter((item): item is string => Boolean(item));
    const missing = artifacts.filter((item) => !existsSync(item));
    if (missing.length) return { name: "install", ok: false, detail: `installed manifest references missing artifacts: ${missing.join(", ")}`, required: true };
    if (record.extension && (!record.extension.bindingDigest || !record.extension.ownerToken)) {
      return { name: "install", ok: false, detail: "installed extension identity is incomplete", required: true };
    }
    return { name: "install", ok: true, detail: `artifacts present; harnesses=${record.harnesses?.join(",") || "none"}; extension=${record.extension ? "bound" : "not-bound"}`, required: true };
  } catch (error) {
    return { name: "install", ok: false, detail: error instanceof Error ? error.message : String(error), required: true };
  }
}

async function apiReachable(env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  let home: string;
  try {
    home = resolveHome(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "api", ok: false, detail: message, required: false };
  }
  const key = tryLoadKey(home, env);
  if (!key) {
    return { name: "api", ok: false, detail: "skipped: no API key", required: false };
  }
  const transport = new LinearTransport({ apiKey: key, timeoutSeconds: 15 });
  const result = await transport.call("viewer", {
    query: "{ viewer { id displayName } }",
  });
  if (result.ok) {
    const data = result.value.data as { viewer?: { displayName?: string } } | undefined;
    const name = data?.viewer?.displayName ?? "viewer";
    return { name: "api", ok: true, detail: `reachable as ${name}`, required: false };
  }
  return {
    name: "api",
    ok: false,
    detail: result.error.message,
    required: false,
  };
}

export async function runDoctorChecks(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorCheck[]> {
  const offline = args.includes("--offline") || args.includes("--skip-api");
  const checks: DoctorCheck[] = [nodePresent(), bunPresent(), keyPresent(env), parseRoundTrip(), configValid(env), databaseValid(env), installation(env), remoteRings(env)];
  if (!offline) {
    checks.push(await apiReachable(env));
  }
  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  const lines = ["fm-linear doctor"];
  for (const check of checks) {
    const mark = check.ok ? "ok" : check.required ? "FAIL" : "WARN";
    const suffix = check.required ? "" : " (optional)";
    lines.push(`  ${mark}  ${check.name}${suffix}: ${check.detail}`);
  }
  return `${lines.join("\n")}\n`;
}

export function doctorExitCode(checks: DoctorCheck[]): number {
  return checks.some((check) => check.required && !check.ok) ? 1 : 0;
}

export async function runDoctor(args: string[]): Promise<number> {
  const checks = await runDoctorChecks(args);
  process.stdout.write(formatDoctor(checks));
  return doctorExitCode(checks);
}
