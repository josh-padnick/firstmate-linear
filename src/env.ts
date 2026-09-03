// FM_HOME resolution and LINEAR_API_KEY loading.
// Ports fm_linear_env_get / fm_linear_load_key from ledger/fm-linear-lib.sh.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.FM_HOME?.trim();
  if (!home) {
    throw new EnvError("FM_HOME is required");
  }
  return home;
}

export function resolveStateDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FM_STATE_OVERRIDE?.trim();
  return override || `${home}/state`;
}

export function envGet(key: string, file: string): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${escaped}=(.*)$`);
  let value = "";
  for (const line of text.split(/\r?\n/)) {
    const match = re.exec(line);
    if (match?.[1] !== undefined) {
      value = match[1];
    }
  }
  value = value.trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

export function loadKey(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.LINEAR_API_KEY?.trim() ?? "";
  if (fromEnv) {
    return fromEnv;
  }
  const service = env.FM_LINEAR_KEYCHAIN_SERVICE?.trim() || "fm-linear";
  const account = env.FM_LINEAR_KEYCHAIN_ACCOUNT?.trim() || env.USER?.trim() || "default";
  const result = spawnSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], { encoding: "utf8" });
  const fromKeychain = result.status === 0 ? (result.stdout || "").trim() : "";
  if (fromKeychain) return fromKeychain;
  const fromFile = envGet("LINEAR_API_KEY", `${home}/.env`);
  if (fromFile) return fromFile;
  throw new EnvError(`missing LINEAR_API_KEY in Keychain service ${service} and ${home}/.env`);
}

export function tryLoadKey(home: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    return loadKey(home, env);
  } catch {
    return null;
  }
}
