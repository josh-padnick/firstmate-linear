import { loadConfig } from "../config/load.ts";
import { StateDatabase } from "../db/database.ts";
import { existsSync, readFileSync } from "node:fs";
import { optionValue } from "./args.ts";

const TEMPLATE_CONTRACTS = {
  reply: { allowed: ["body", "verdict", "next"], required: ["body", "next"] },
  report: { allowed: ["summary", "events", "drift"], required: ["summary", "events", "drift"] },
  review_walkthrough: { allowed: ["issue", "title", "outcome", "changes", "verification", "review"], required: ["issue", "title"] },
} as const;

export function lintContract(env: NodeJS.ProcessEnv = process.env): string[] {
  const config = loadConfig(env);
  const errors: string[] = [];
  for (const team of config.teams) {
    const names = Object.values(team.statuses);
    if (new Set(names).size !== names.length) errors.push(`${team.key} maps multiple keys to the same status`);
    if (team.managed !== "assignee:self" && team.managed !== "all") errors.push(`${team.key} has invalid managed scope`);
  }
  for (const name of Object.keys(TEMPLATE_CONTRACTS) as Array<keyof typeof TEMPLATE_CONTRACTS>) {
    const contract = TEMPLATE_CONTRACTS[name];
    const path = config.templates[name];
    if (!existsSync(path)) { errors.push(`${name} template is missing: ${path}`); continue; }
    const text = readFileSync(path, "utf8");
    const placeholders = [...text.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1]!.trim());
    for (const placeholder of placeholders) if (!(contract.allowed as readonly string[]).includes(placeholder)) errors.push(`${name} template has unsupported placeholder: ${placeholder}`);
    for (const required of contract.required) if (!placeholders.includes(required)) errors.push(`${name} template is missing placeholder: ${required}`);
    if (name === "review_walkthrough") for (const id of ["outcome", "changes", "verification", "review"]) {
      if (!new RegExp(`<section\\b[^>]*\\bid=["']${id}["']`, "i").test(text)) errors.push(`review_walkthrough template is missing section: ${id}`);
    }
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
    try {
      const key = optionValue(args, "--team")?.toUpperCase() ?? null;
      const config = loadConfig(env);
      const team = config.teams.find((item) => item.key === key);
      if (!team) throw new Error(`configured team not found: ${key ?? "(missing)"}`);
      const db = StateDatabase.open(env);
      try {
        for (const [statusKey, name] of Object.entries(team.statuses)) {
          db.enqueueReconciliation({ key: `contract:${team.key}:state:${name}`, kind: "linear.workflow-state", target: team.key, payload: { team: team.key, status_key: statusKey, name } });
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
        db.enqueueReconciliation({ key: "contract:workspace:label-group:Agent", kind: "linear.label-group", target: "Agent", payload: { name: "Agent" } });
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
