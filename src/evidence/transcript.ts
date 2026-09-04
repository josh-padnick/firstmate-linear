import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StateDatabase, TaskLink } from "../db/database.ts";
import { parseIso } from "../time.ts";

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && /\.(jsonl|log|txt)$/.test(entry.name)) out.push(child);
    }
  };
  try { visit(root); } catch { /* inaccessible locator */ }
  return out;
}

function locator(link: TaskLink, userHome: string): string | null {
  if (!link.harness) return null;
  if (link.harness === "claude") {
    if (!link.worktree) return null;
    const encoded = link.worktree.replaceAll("/", "-");
    return join(userHome, ".claude", "projects", encoded);
  }
  if (link.harness === "codex") return join(userHome, ".codex", "sessions");
  if (link.harness === "grok") {
    if (!link.worktree) return null;
    const encoded = link.worktree.replaceAll("/", "-");
    return join(userHome, ".grok", "sessions", encoded);
  }
  return null;
}

function inWindow(modified: number, link: TaskLink, now: number): boolean {
  const start = parseIso(link.spawned_at) ?? 0;
  const end = parseIso(link.torn_down_at ?? "") ?? now;
  return modified / 1000 >= start && modified / 1000 <= end + 1;
}

export function transcriptTail(db: StateDatabase, issue: string, count: number, env: NodeJS.ProcessEnv = process.env): string {
  const userHome = env.FM_LINEAR_USER_HOME?.trim() || homedir();
  const now = Number(env.FM_LINEAR_NOW_EPOCH ?? Date.now() / 1000);
  const links = db.taskLinks(issue).filter((item) => item.role === "primary" && item.worktree);
  const link = links.at(-1);
  if (!link) return "transcript tail: omitted (no linked worker session locator)";
  const root = locator(link, userHome);
  if (!root) return `transcript tail: omitted (no locator for harness ${link.harness ?? "unknown"})`;
  const candidates = files(root).flatMap((path) => {
    try {
      const modified = statSync(path).mtimeMs;
      if (!inWindow(modified, link, now)) return [];
      if (link.harness === "codex" && !readFileSync(path, "utf8").includes(link.worktree!)) return [];
      return [{ path, modified }];
    } catch { return []; }
  }).sort((left, right) => left.modified - right.modified);
  const selected = candidates.at(-1)?.path;
  if (!selected) return "transcript tail: omitted (no session in the task time window)";
  let lines: string[];
  try { lines = readFileSync(selected, "utf8").split(/\r?\n/).filter(Boolean).slice(-count); }
  catch { return "transcript tail: omitted (session became unavailable)"; }
  return [`transcript tail (${link.harness}):`, ...lines].join("\n");
}
