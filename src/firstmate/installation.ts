import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIdentity } from "../support/build-identity";
import { commandEnvironment, runCommand } from "../support/command";

declare const FM_LINEAR_BUILD_ID: string;

import { FmError } from "../support/errors";
import { hash, readBounded } from "../support/files";
import { type FirstmateInstallation, HomeId } from "./types";

export const ADAPTER_VERSION = "0.1.0";
export const SUITE_VERSION = "2";
export async function fingerprintTree(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(dir: string, prefix: string) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const rel = `${prefix}/${name}`;
      const stat = await lstat(path);
      if (entries.length > 4096 || stat.isSymbolicLink())
        throw new FmError(
          "firstmate.contract_failed",
          "The installation contains unsupported file entries.",
        );
      if (stat.isDirectory()) await walk(path, rel);
      else if (stat.isFile() && stat.nlink === 1 && stat.size <= 8 * 1024 * 1024)
        entries.push(`${rel}:${stat.mode & 0o777}:${hash(await readFile(path))}`);
      else
        throw new FmError(
          "firstmate.contract_failed",
          "The installation contains an unsupported file.",
        );
    }
  }
  await walk(root, "");
  return entries;
}
export async function getFirstmateInstallation(options: {
  home: string;
  codeRoot: string;
}): Promise<FirstmateInstallation> {
  // Discovery is deliberately explicit: multiple Firstmate homes are never guessed from cwd.
  const home = await realpath(options.home);
  const codeRoot = await realpath(options.codeRoot);
  if (!["darwin", "linux"].includes(process.platform))
    throw new FmError("config.invalid", "Only macOS and Linux are supported.");
  const code = await fingerprintTree(join(codeRoot, "bin"));
  const config = await fingerprintTree(join(home, "config")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const commitResult = await runCommand("/usr/bin/git", ["-C", codeRoot, "rev-parse", "HEAD"], {
    cwd: home,
    env: commandEnvironment(home, codeRoot),
  });
  const commit =
    commitResult.code === 0 && /^[a-f0-9]{40,64}\n?$/.test(commitResult.stdout)
      ? commitResult.stdout.trim()
      : null;
  // Package identity is included because shell helpers may invoke installed extension executables.
  const packages = await fingerprintTree(join(home, "data", "extensions", "packages")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const fingerprint = hash(
    JSON.stringify({
      code,
      config,
      packages,
      commit,
      platform: process.platform,
      arch: process.arch,
      adapter: ADAPTER_VERSION,
      adapterBuild:
        typeof FM_LINEAR_BUILD_ID === "string"
          ? FM_LINEAR_BUILD_ID
          : await buildIdentity(fileURLToPath(new URL("../../", import.meta.url))),
      bun: Bun.version,
      suite: SUITE_VERSION,
    }),
  );
  return {
    homeId: HomeId.parse(`home-${hash(home).slice(0, 24)}`),
    home,
    codeRoot,
    commit,
    fingerprint,
    platform: process.platform,
  };
}
export async function metadata(
  home: string,
  taskId: string,
): Promise<Record<string, string> | null> {
  const { confinedFile } = await import("../support/files");
  const path = await confinedFile(home, ["state", `${taskId}.meta`], true);
  if (!path) return null;
  const record: Record<string, string> = Object.create(null);
  for (const line of (await readBounded(path)).split("\n")) {
    const at = line.indexOf("=");
    if (at < 1) continue;
    const key = line.slice(0, at);
    if (Object.hasOwn(record, key))
      throw new FmError(
        "firstmate.contract_failed",
        "Duplicate task metadata fields were refused.",
      );
    record[key] = line.slice(at + 1);
  }
  return record;
}
