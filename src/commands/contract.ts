import { loadConfig } from "../config/load.ts";
import { StateDatabase } from "../db/database.ts";

export function lintContract(env: NodeJS.ProcessEnv = process.env): string[] {
  const config = loadConfig(env);
  const errors: string[] = [];
  for (const team of config.teams) {
    const names = Object.values(team.statuses);
    if (new Set(names).size !== names.length) errors.push(`${team.key} maps multiple keys to the same status`);
    if (team.managed !== "assignee:self" && team.managed !== "all") errors.push(`${team.key} has invalid managed scope`);
  }
  return errors;
}

export function runContract(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const sub = args[0];
  if (sub === "lint") {
    try {
      const errors = lintContract(env);
      if (errors.length) throw new Error(errors.join("; "));
      const config = loadConfig(env);
      process.stdout.write(`fm-linear contract lint: ok teams=${config.teams.map((team) => team.key).join(",")}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`fm-linear contract lint: REFUSED ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  if (sub === "apply-states") {
    const teamFlag = args.indexOf("--team");
    const key = teamFlag >= 0 ? args[teamFlag + 1]?.toUpperCase() : null;
    try {
      const config = loadConfig(env);
      const team = config.teams.find((item) => item.key === key);
      if (!team) throw new Error(`configured team not found: ${key ?? "(missing)"}`);
      const db = StateDatabase.open(env);
      try {
        for (const [statusKey, name] of Object.entries(team.statuses)) {
          db.enqueue({ key: `contract:${team.key}:state:${name}`, kind: "linear.workflow-state", target: team.key, payload: { team: team.key, status_key: statusKey, name } });
        }
      } finally { db.close(); }
      process.stdout.write(`fm-linear contract apply-states: queued ${Object.keys(team.statuses).length} checks for ${team.key}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`fm-linear contract apply-states: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  if (sub === "apply-labels") {
    try {
      loadConfig(env);
      const db = StateDatabase.open(env);
      try {
        db.enqueue({ key: "contract:workspace:label-group:Agent", kind: "linear.label-group", target: "Agent", payload: { name: "Agent" } });
      } finally { db.close(); }
      process.stdout.write("fm-linear contract apply-labels: queued workspace Agent group check; label values are never created automatically\n");
      return 0;
    } catch (error) {
      process.stderr.write(`fm-linear contract apply-labels: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  process.stderr.write("Usage: fm-linear contract lint | apply-states --team KEY | apply-labels\n");
  return 2;
}
