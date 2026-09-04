import { loadConfig } from "../config/load.ts";
import { StateDatabase } from "../db/database.ts";
import { existsSync, readFileSync } from "node:fs";
import { optionValue } from "./args.ts";
import { GATE_ROLES, WORKFLOW_ROLES, type WorkflowRole } from "../config/schema.ts";
import { runtimePaths } from "../paths.ts";

const TEMPLATE_CONTRACTS = {
  reply: { allowed: ["body", "verdict", "next"], required: ["body", "next"] },
  report: { allowed: ["summary", "events", "drift"], required: ["summary", "events", "drift"] },
  review_walkthrough: { allowed: ["issue", "title", "outcome", "changes", "verification", "review"], required: ["issue", "title"] },
} as const;

export function lintContract(env: NodeJS.ProcessEnv = process.env, availableStatuses: Record<string, string[]> = {}): string[] {
  if (Object.keys(availableStatuses).length === 0) {
    try { availableStatuses = JSON.parse(readFileSync(`${runtimePaths(env).root}/team-statuses.json`, "utf8")) as Record<string, string[]>; }
    catch { /* live discovery has not been cached yet */ }
  }
  const config = loadConfig(env);
  const errors: string[] = [];
  for (const team of config.teams) {
    const names = Object.values(team.roles);
    if (new Set(names).size !== names.length) errors.push(`${team.key} maps multiple roles to the same status`);
    if (team.managed !== "assignee:self" && team.managed !== "all") errors.push(`${team.key} has invalid managed scope`);
    const available = availableStatuses[team.key];
    if (available) for (const [role, name] of Object.entries(team.roles)) {
      if (!available.includes(name)) errors.push(`${team.key} status ${JSON.stringify(name)} mapped to role ${role} does not exist`);
    }
    for (const gateRole of GATE_ROLES) {
      if (!team.roles[gateRole]) continue;
      const next = config.gates[gateRole].next;
      const hasFallback = Boolean(team.roles[next])
        || (gateRole === "review-gate" && (team.roles["merge-gate"] || team.roles.done))
        || (gateRole === "plan-gate" && team.roles.building);
      if (!hasFallback) errors.push(`${team.key} gate ${gateRole} has no mapped next role or fallback`);
    }
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
      const info = config.teams.map((team) => {
        const unmapped = WORKFLOW_ROLES.filter((role) => !team.roles[role]);
        return `${team.key} unmapped=${unmapped.length ? unmapped.join(",") : "none"}`;
      }).join("; ");
      process.stdout.write(`fm-linear contract lint: ok teams=${config.teams.map((team) => team.key).join(",")}\ninfo: ${info}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`fm-linear contract lint: REFUSED ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  if (sub === "apply-states") {
    try {
      const key = optionValue(args, "--team")?.toUpperCase() ?? null;
      const role = optionValue(args, "--role") as WorkflowRole | null;
      const requestedName = optionValue(args, "--name")?.trim() || null;
      const config = loadConfig(env);
      const team = config.teams.find((item) => item.key === key);
      if (!team) throw new Error(`configured team not found: ${key ?? "(missing)"}`);
      if (!role || !(WORKFLOW_ROLES as readonly string[]).includes(role)) throw new Error("apply-states requires --role <workflow-role>");
      const name = team.roles[role] ?? requestedName;
      if (!name) throw new Error(`role ${role} is unmapped for ${team.key}; pass --name after choosing the status name`);
      const yes = args.includes("--yes");
      if (!yes) {
        if (!process.stdin.isTTY) throw new Error(`refusing non-interactive status creation for ${role}; pass --yes after explicit approval`);
        process.stdout.write(`role ${JSON.stringify(role)} is ${team.roles[role] ? "mapped" : "unmapped"}; create a status ${JSON.stringify(name)} for it? [y/N] `);
        const answer = readFileSync(0, "utf8").trim().toLocaleLowerCase("en-US");
        if (answer !== "y" && answer !== "yes") throw new Error("status creation declined");
      }
      const db = StateDatabase.open(env);
      try {
        db.enqueueReconciliation({ key: `contract:${team.key}:role:${role}:${name}`, kind: "linear.workflow-state", target: team.key, payload: { team: team.key, role, name } });
      } finally { db.close(); }
      process.stdout.write(`fm-linear contract apply-states: queued ${role} status check for ${team.key}\n`);
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
  process.stderr.write("Usage: fm-linear contract lint | apply-states --team KEY --role ROLE [--name STATUS] [--yes] | apply-labels\n");
  return 2;
}
