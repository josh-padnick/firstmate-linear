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

function inWindow(path: string, link: TaskLink, now: number): boolean {
  const modified = statSync(path).mtimeMs / 1000;
  const start = parseIso(link.spawned_at) ?? 0;
  const end = parseIso(link.torn_down_at ?? "") ?? now;
  return modified >= start && modified <= end + 1;
}

export function transcriptTail(db: StateDatabase, issue: string, count: number, env: NodeJS.ProcessEnv = process.env): string {
  const userHome = env.FM_LINEAR_USER_HOME?.trim() || homedir();
  const now = Number(env.FM_LINEAR_NOW_EPOCH ?? Date.now() / 1000);
  const links = db.taskLinks(issue).filter((item) => item.role === "primary" && item.worktree);
  const link = links.at(-1);
  if (!link) return "transcript tail: omitted (no linked worker session locator)";
  const root = locator(link, userHome);
  if (!root) return `transcript tail: omitted (no locator for harness ${link.harness ?? "unknown"})`;
  const candidates = files(root)
    .filter((path) => inWindow(path, link, now))
    .filter((path) => link.harness !== "codex" || readFileSync(path, "utf8").includes(link.worktree!))
    .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs);
  const selected = candidates.at(-1);
  if (!selected) return "transcript tail: omitted (no session in the task time window)";
  const lines = readFileSync(selected, "utf8").split(/\r?\n/).filter(Boolean).slice(-count);
  return [`transcript tail (${link.harness}):`, ...lines].join("\n");
}
