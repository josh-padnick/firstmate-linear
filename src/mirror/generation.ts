import { existsSync, readFileSync, statSync } from "node:fs";
import { sha256 } from "../hash.ts";

export function fileIncarnation(path: string): string | null {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

export function sidecarGeneration(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  const match = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`).exec(content);
  return match?.[1] ? `gen:${match[1]}` : `file:${fileIncarnation(path)}:${sha256(content)}`;
}
