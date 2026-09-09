import { loadConfig } from "../config/load.ts";
import { StateDatabase } from "../db/database.ts";
import { resolveHome } from "../env.ts";
import { applyMirrorPlan, planMirror } from "../mirror/plan.ts";
import { scanPullRequests } from "../mirror/pr.ts";
import { scanFleet } from "../mirror/scan.ts";

export function runMirror(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const sub = args[0] ?? "--plan";
  if (sub !== "--plan" && sub !== "apply") {
    process.stderr.write("Usage: fm-linear mirror --plan|apply [--skip-gh]\n");
    return 2;
  }
  const db = StateDatabase.open(env);
  try {
    const config = loadConfig(env);
    const scan = scanFleet(resolveHome(env), db, env);
    const pr = args.includes("--skip-gh") ? { observations: [], findings: [] } : scanPullRequests(resolveHome(env), db, undefined, env);
    const plan = planMirror(db, config, [...scan.observations, ...pr.observations]);
    for (const action of plan.actions) process.stdout.write(`${action.issue}\t${action.description}\tcause=${action.cause}\n`);
    for (const finding of [...scan.findings.map((item) => ({ code: item.code, issue: item.task, detail: item.detail })), ...pr.findings, ...plan.findings]) {
      process.stdout.write(`REPORT\t${finding.code}\t${finding.issue}\t${finding.detail}\n`);
    }
    const count = sub === "apply" ? applyMirrorPlan(db, { ...config, features: { ...config.features, mirror: "on" } }, plan) : 0;
    if (!plan.actions.length && !scan.findings.length && !pr.findings.length && !plan.findings.length) process.stdout.write("fm-linear mirror: no drift\n");
    else process.stdout.write(`fm-linear mirror: planned=${plan.actions.length} queued=${count}\n`);
    return 0;
  } finally { db.close(); }
}
