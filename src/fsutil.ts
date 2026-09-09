import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LIVE_STATE_FORBIDDEN } from "./paths.ts";

export class FsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FsError";
  }
}

function assertNotLivePath(path: string): void {
  const parts = path.split("/");
  for (const part of parts) {
    if ((LIVE_STATE_FORBIDDEN as readonly string[]).includes(part)) {
      throw new FsError(`refusing to write live runtime path: ${path}`);
    }
  }
}

export function ensurePrivateDir(path: string): void {
  assertNotLivePath(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o700) {
    throw new FsError(`directory mode ${mode.toString(8)} is not 700: ${path}`);
  }
}

export function atomicWriteFile(path: string, contents: string, mode = 0o600): void {
  assertNotLivePath(path);
  const parent = dirname(path);
  ensurePrivateDir(parent);
  const tmp = join(parent, `.fm-linear.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, contents, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
    chmodSync(path, mode);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw error;
  }
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export type Lock = { path: string; held: boolean };

export function lockAcquire(path: string): "ok" | "busy" | "unsafe" {
  assertNotLivePath(path);
  try {
    mkdirSync(path);
  } catch {
    try {
      const owner = readFileSync(join(path, "pid"), "utf8").trim();
      const pid = Number(owner);
      if (!Number.isInteger(pid) || pid <= 0) {
        return "unsafe";
      }
      try {
        process.kill(pid, 0);
        return "busy";
      } catch {
        try {
          unlinkSync(join(path, "pid"));
          rmSync(path, { recursive: true, force: true });
          mkdirSync(path);
        } catch {
          return "unsafe";
        }
      }
    } catch {
      return "unsafe";
    }
  }
  try {
    writeFileSync(join(path, "pid"), `${process.pid}\n`, { mode: 0o600 });
    return "ok";
  } catch {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // ignore
    }
    return "unsafe";
  }
}

export function lockRelease(path: string): void {
  try {
    const owner = readFileSync(join(path, "pid"), "utf8").trim();
    if (owner !== String(process.pid)) {
      return;
    }
    unlinkSync(join(path, "pid"));
    rmSync(path, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
