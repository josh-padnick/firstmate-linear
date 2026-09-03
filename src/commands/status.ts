import { readText } from "../fsutil.ts";
import { StateDatabase } from "../db/database.ts";
import { runtimePaths } from "../paths.ts";
import { nowEpoch, parseIso } from "../time.ts";

function age(iso: string | null, env: NodeJS.ProcessEnv): string {
  if (!iso) return "never";
  const epoch = parseIso(iso);
  if (epoch === null) return "invalid";
  const seconds = Math.max(0, nowEpoch(env) - epoch);
  return seconds < 90 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

export function buildStatus(env: NodeJS.ProcessEnv = process.env): { text: string; code: number } {
  const paths = runtimePaths(env);
  const db = StateDatabase.open(env);
  try {
    let health: any = null;
    try { health = JSON.parse(readText(paths.serviceHealth) ?? "null"); } catch { health = null; }
    const pending = db.listEvents(["waiting-for-core"]);
    const activeJobs = db.jobs(["pending", "running", "retry", "dead"]);
    const dead = activeJobs.filter((job) => job.state === "dead");
    const activeTasks = db.taskLinks(undefined, true);
    const lines = [
      "fm-linear status",
      `  service: ${health?.last_error ? "failed" : health ? "ok" : "not-started"} last_success=${age(health?.last_success_at ?? null, env)} failures=${health?.consecutive_failures ?? 0}`,
      `  inbox: ${pending.length} pending${pending[0] ? ` oldest=${pending[0].issue}:${pending[0].token}` : ""}`,
      `  jobs: ${activeJobs.length} active/retry/dead; dead=${dead.length}`,
      `  tasks: ${activeTasks.length} active link(s)`,
      `  issues: ${db.latestSnapshots().length} managed snapshot(s)`,
      `  database: ${paths.database}`,
      `  socket: ${paths.socket}`,
    ];
    return { text: `${lines.join("\n")}\n`, code: health?.last_error || dead.length ? 1 : 0 };
  } finally { db.close(); }
}

export function runStatus(_args: string[], env: NodeJS.ProcessEnv = process.env): number {
  try { const result = buildStatus(env); process.stdout.write(result.text); return result.code; }
  catch (error) { process.stderr.write(`fm-linear status: ${error instanceof Error ? error.message : String(error)}\n`); return 2; }
}
