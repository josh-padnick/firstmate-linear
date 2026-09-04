import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Observation, StateDatabase, TaskLink } from "../db/database.ts";
import { sha256 } from "../hash.ts";
import { nowIso } from "../time.ts";

export type ScanFinding = { code: string; task: string; detail: string };
export type ScanResult = { observations: Observation[]; findings: ScanFinding[] };

function fields(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = /^([^=]+)=(.*)$/.exec(line);
      if (match?.[1]) out[match[1].trim()] = match[2] ?? "";
    }
  } catch { /* absent */ }
  return out;
}

export function parseStatusLine(line: string): { verb: string; key: string; note: string } | null {
  const match = /^([a-z][a-z0-9-]*)(?:\s+\[key=([^\]]+)\])?:\s*(.*)$/.exec(line.trim());
  if (!match?.[1]) return null;
  const note = match[3] ?? "";
  const nested = /^\[key=([^\]]+)\]\s*(.*)$/.exec(note);
  return { verb: match[1], key: match[2] ?? nested?.[1] ?? "default", note: nested?.[2] ?? note };
}

function readNewLines(db: StateDatabase, path: string): { rows: Array<{ line: string; offset: number }>; cursorName: string; cursorValue: string } | null {
  const name = `status:${path}`;
  const raw = db.cursor(name);
  let offset = 0;
  if (raw) {
    try { offset = Number((JSON.parse(raw) as { offset?: number }).offset ?? 0); } catch { offset = 0; }
  }
  const content = readFileSync(path);
  if (offset < 0 || offset > content.length) offset = 0;
  const remaining = content.subarray(offset);
  const lastNewline = remaining.lastIndexOf(10);
  if (lastNewline < 0) return null;
  const complete = remaining.subarray(0, lastNewline + 1).toString("utf8");
  const rows: Array<{ line: string; offset: number }> = [];
  let consumed = 0;
  for (const line of complete.split("\n").slice(0, -1)) {
    rows.push({ line, offset: offset + consumed });
    consumed += Buffer.byteLength(line) + 1;
  }
  return { rows, cursorName: name, cursorValue: JSON.stringify({ offset: offset + lastNewline + 1 }) };
}

function importLegacyLinks(home: string, db: StateDatabase): void {
  const path = join(home, "data", "linear-map.tsv");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const [task, issue] = line.split("\t");
    if (!task || !issue || db.taskLinks(issue, true).some((link) => link.task === task)) continue;
    const meta = fields(join(home, "state", `${task}.meta`));
    db.linkTask({ task, issue, role: "primary", worktree: meta.worktree || null, harness: meta.harness || null, spawned_at: nowIso(), torn_down_at: existsSync(join(home, "state", `${task}.meta`)) ? null : nowIso() });
  }
}

export function scanFleet(home: string, db: StateDatabase, env: NodeJS.ProcessEnv = process.env): ScanResult {
  importLegacyLinks(home, db);
  const state = join(home, "state");
  const observations: Observation[] = [];
  const findings: ScanFinding[] = [];
  let names: string[] = [];
  try { names = readdirSync(state); } catch { return { observations, findings }; }
  for (const name of names.filter((item) => item.endsWith(".meta"))) {
    const task = basename(name, ".meta");
    const current = db.taskLinks(undefined, true).filter((link) => link.task === task);
    if (!current.length) findings.push({ code: "TASK_WITHOUT_LINK", task, detail: "live .meta has no Linear task link" });
    const meta = fields(join(state, name));
    for (const link of current) {
      db.linkTask({ ...link, worktree: meta.worktree || link.worktree, harness: meta.harness || link.harness });
      const model = meta.delegate === "devin" ? "devin" : meta.model || "unknown";
      const observation: Observation = {
        id: `obs:${sha256(`${task}:${link.issue}:${meta.spawn_gen ?? "spawn"}:model:${model}`)}`,
        source: "summary", task, issue: link.issue, verb: "model-resolved", key: "model",
        note: `model=${model}`, observed_at: nowIso(env),
      };
      if (db.observe(observation)) observations.push(observation);
    }
  }
  for (const name of names.filter((item) => item.endsWith(".status"))) {
    const task = basename(name, ".status");
    const links = db.taskLinks(undefined, true).filter((link) => link.task === task);
    if (!links.length) continue;
    const path = join(state, name);
    const stat = statSync(path);
    const batch = readNewLines(db, path);
    if (!batch) continue;
    const inserted: Observation[] = [];
    db.transaction(() => {
      for (const row of batch.rows) {
        const parsed = parseStatusLine(row.line);
        if (!parsed) continue;
        for (const link of links) {
          const observation: Observation = {
            id: `obs:${sha256(`${path}:${link.issue}:${stat.ino}:${row.offset}:${row.line}`)}`,
            source: "status", task, issue: link.issue, verb: parsed.verb,
            key: parsed.key, note: parsed.note, observed_at: nowIso(env),
          };
          if (db.observe(observation)) inserted.push(observation);
        }
      }
      db.setCursor(batch.cursorName, batch.cursorValue);
    });
    observations.push(...inserted);
  }
  const summaryPath = join(state, "home-summary.json");
  if (existsSync(summaryPath)) {
    try {
      const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as { generated?: string; active_children?: Array<{ id?: string; state?: string }> };
      for (const child of summary.active_children ?? []) {
        if (!child.id || !child.state) continue;
        for (const link of db.taskLinks(undefined, true).filter((item) => item.task === child.id)) {
          const observation: Observation = { id: `obs:${sha256(`${summary.generated}:${child.id}:${link.issue}:${child.state}`)}`, source: "summary", task: child.id, issue: link.issue, verb: child.state, key: "summary", note: null, observed_at: summary.generated ?? nowIso(env) };
          if (db.observe(observation)) observations.push(observation);
        }
      }
    } catch { findings.push({ code: "INVALID_SUMMARY", task: "home", detail: "state/home-summary.json is invalid" }); }
  }
  return { observations, findings };
}
