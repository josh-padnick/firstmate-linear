import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath, loadConfigFile, parseConfig } from "../config/load.ts";
import { StateDatabase } from "../db/database.ts";
import { resolveHome } from "../env.ts";
import { atomicWriteFile, ensurePrivateDir } from "../fsutil.ts";
import { ASSETS } from "../assets.ts";
import { optionValue } from "./args.ts";
import { tryLoadKey } from "../env.ts";
import { LinearTransport } from "../transport.ts";
import { REQUIRED_WORKFLOW_ROLES, WORKFLOW_ROLES, type WorkflowRole } from "../config/schema.ts";
import { createInterface } from "node:readline/promises";
import { runtimePaths } from "../paths.ts";

export function runInit(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const home = resolveHome(env);
  const destination = configPath(env);
  let captainInput: string | null;
  let teamInput: string | null;
  try {
    captainInput = optionValue(args, "--captain") ?? env.FM_LINEAR_CAPTAIN_NAME?.trim() ?? null;
    teamInput = optionValue(args, "--team")?.toUpperCase() ?? null;
  } catch (error) {
    process.stderr.write(`fm-linear init: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  try {
    if (!existsSync(destination)) {
      if (!captainInput || !teamInput) {
        process.stderr.write("fm-linear init: --captain NAME and --team KEY are required for a new config\n");
        return 2;
      }
      let rendered = ASSETS.configExample
        .replace("CAPTAIN_NAME", JSON.stringify(captainInput))
        .replace("key: TEAM", `key: ${JSON.stringify(teamInput)}`);
      const discoveredRoles = env.FM_LINEAR_INIT_ROLE_MAP?.trim();
      if (discoveredRoles) {
        const roles = JSON.parse(discoveredRoles) as Partial<Record<WorkflowRole, string>>;
        const block = Object.entries(roles).map(([role, name]) => `      ${role}: ${JSON.stringify(name)}`).join("\n");
        rendered = rendered.replace(/    roles:\n(?:      .*\n)+?    agent_labels:/, `    roles:\n${block}\n    agent_labels:`);
      }
      parseConfig(Bun.YAML.parse(rendered), destination);
      ensurePrivateDir(join(home, "config"));
      ensurePrivateDir(join(home, "state", "linear"));
      atomicWriteFile(destination, rendered);
      for (const [contents, targetName] of [
        [ASSETS.replyTemplate, "reply.md"],
        [ASSETS.reportTemplate, "report.md"],
        [ASSETS.reviewTemplate, "review-walkthrough.html"],
      ] as const) {
        const target = join(dirname(destination), targetName);
        if (!existsSync(target)) atomicWriteFile(target, contents, 0o600);
      }
    }
    loadConfigFile(destination);
    const db = StateDatabase.open(env);
    db.close();
  } catch (error) {
    process.stderr.write(`fm-linear init: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  process.stdout.write(`fm-linear init: ready at ${home}\nconfig: ${destination}\n`);
  return 0;
}

const ROLE_NAMES: Record<WorkflowRole, string[]> = {
  plan: ["plan in progress", "planning"],
  "plan-gate": ["approve plan", "plan review"],
  waiting: ["waiting", "backlog"],
  building: ["in progress", "building", "started"],
  "review-gate": ["in review", "approve deliverable", "review"],
  validating: ["validating code", "validating", "verification"],
  "merge-gate": ["approve merge", "merge review"],
  "decision-captain": ["needs decision"],
  "decision-firstmate": ["needs firstmate decision"],
  done: ["done", "completed"],
  canceled: ["canceled", "cancelled"],
};

export function suggestRoleAssignments(statuses: readonly string[]): Partial<Record<WorkflowRole, string>> {
  const remaining = new Set(statuses);
  const roles: Partial<Record<WorkflowRole, string>> = {};
  for (const role of WORKFLOW_ROLES) {
    const match = [...remaining].find((status) => ROLE_NAMES[role].includes(status.trim().toLocaleLowerCase("en-US")));
    if (match) { roles[role] = match; remaining.delete(match); }
  }
  return roles;
}

async function discoverStatuses(team: string, env: NodeJS.ProcessEnv): Promise<string[] | null> {
  const key = tryLoadKey(resolveHome(env), env);
  if (!key) return null;
  const transport = new LinearTransport({ apiKey: key });
  const result = await transport.call("init-team-statuses", {
    query: `query($team:String!){teams(first:2,filter:{key:{eq:$team}}){nodes{key states{nodes{name}}}}}`,
    variables: { team },
  });
  if (!result.ok) return null;
  const nodes = (result.value.data as any)?.teams?.nodes ?? [];
  if (nodes.length !== 1) return null;
  return (nodes[0].states?.nodes ?? []).map((item: any) => item.name).filter((name: unknown): name is string => typeof name === "string" && Boolean(name));
}

export async function runInitWithDiscovery(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const destination = configPath(env);
  if (existsSync(destination) || env.FM_LINEAR_INIT_ROLE_MAP) return runInit(args, env);
  let team: string | null;
  try { team = optionValue(args, "--team")?.toUpperCase() ?? null; }
  catch { return runInit(args, env); }
  if (!team) return runInit(args, env);
  const statuses = await discoverStatuses(team, env);
  if (!statuses?.length) return runInit(args, env);
  const suggestions = suggestRoleAssignments(statuses);
  let roles = suggestions;
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    roles = {};
    try {
      process.stdout.write(`Discovered Linear statuses for ${team}: ${statuses.join(", ")}\n`);
      for (const role of WORKFLOW_ROLES) {
        const suggested = suggestions[role];
        const answer = (await prompt.question(`Assign role ${role} [${suggested ?? "unmapped"}]: `)).trim();
        const selected = answer || suggested;
        if (selected && !statuses.includes(selected)) throw new Error(`status does not exist on ${team}: ${selected}`);
        if (selected) roles[role] = selected;
      }
    } catch (error) {
      process.stderr.write(`fm-linear init: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    } finally { prompt.close(); }
  }
  const missing = REQUIRED_WORKFLOW_ROLES.find((role) => !roles[role]);
  if (missing) {
    process.stderr.write(`fm-linear init: discovered statuses could not map required role ${missing}; assign it interactively or edit the contract\n`);
    return 1;
  }
  const code = runInit(args, { ...env, FM_LINEAR_INIT_ROLE_MAP: JSON.stringify(roles) });
  if (code === 0) atomicWriteFile(join(runtimePaths(env).root, "team-statuses.json"), `${JSON.stringify({ [team]: statuses }, null, 2)}\n`);
  return code;
}
