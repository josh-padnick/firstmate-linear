import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { Digest } from "../firstmate/types";
import { FmError } from "./errors";

export const hash = (value: string | Uint8Array) =>
  Digest.parse(createHash("sha256").update(value).digest("hex"));
export async function confinedFile(
  root: string,
  parts: string[],
  optional = false,
): Promise<string | null> {
  const canonical = await realpath(root);
  let path = canonical;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part === "." || part === ".." || part.includes("/") || part.includes("\\"))
      throw new FmError("config.invalid", "Invalid relative file path.");
    path = join(path, part);
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (optional && error.code === "ENOENT") return null;
      throw new FmError("firstmate.contract_failed", "A required Firstmate file is unavailable.");
    });
    if (!stat) return null;
    if (
      stat.isSymbolicLink() ||
      (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) ||
      (stat.nlink > 1 && stat.isFile())
    )
      throw new FmError("firstmate.contract_failed", "An unsafe Firstmate file was refused.");
  }
  const rel = relative(canonical, await realpath(path));
  if (rel.startsWith(`..${sep}`))
    throw new FmError("firstmate.contract_failed", "A file escaped the selected home.");
  return path;
}
export async function readBounded(path: string, limit = 128 * 1024): Promise<string> {
  const f = await open(path, "r");
  try {
    const stat = await f.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new FmError("firstmate.contract_failed", "A file exceeds the supported contract.");
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await f.read(bytes, 0, limit + 1, 0);
    if (bytesRead !== stat.size || bytesRead > limit)
      throw new FmError("firstmate.contract_failed", "A file exceeds the supported contract.");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } finally {
    await f.close();
  }
}
// The synchronous section is bounded to one small brief, allowing SQLite to serialize writers.
export function readBoundedSync(path: string, limit = 128 * 1024): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
      throw new FmError("firstmate.contract_failed", "An unsafe or oversized brief was refused.");
    const bytes = Buffer.alloc(limit + 1);
    const length = readSync(fd, bytes, 0, limit + 1, 0);
    if (length !== stat.size || length > limit)
      throw new FmError("firstmate.contract_failed", "The brief exceeds the supported size.");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}
export function replaceBriefSync(path: string, expected: string, content: string) {
  const temporary = join(dirname(path), `.fm-linear-${crypto.randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
    if (hash(readBoundedSync(path)) !== expected)
      throw new FmError("firstmate.stale_brief", "The brief changed before publication.");
    renameSync(temporary, path);
    const parent = openSync(dirname(path), "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {}
  }
}
