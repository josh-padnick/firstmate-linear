import { StateDatabase } from "../db/database.ts";
import { nowIso } from "../time.ts";
import { optionValue } from "./args.ts";

export function runTask(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const sub = args[0];
  const db = StateDatabase.open(env);
  try {
    if (sub === "link") {
      const task = args[1];
      const issue = args[2];
      const role = optionValue(args, "--role") ?? "primary";
      if (!task || !issue || (role !== "primary" && role !== "support")) {
        process.stderr.write("Usage: fm-linear task link TASK ISSUE [--role primary|support] [--worktree path] [--harness name]\n");
        return 2;
      }
      db.linkTask({ task, issue, role, worktree: optionValue(args, "--worktree"), harness: optionValue(args, "--harness"), spawned_at: optionValue(args, "--spawned-at") ?? nowIso(env), torn_down_at: null });
      process.stdout.write(`fm-linear task: linked ${task} -> ${issue} (${role})\n`);
      return 0;
    }
    if (sub === "close") {
      const task = args[1];
      if (!task) return 2;
      db.closeTask(task, nowIso(env));
      process.stdout.write(`fm-linear task: closed ${task}\n`);
      return 0;
    }
    if (sub === "list") {
      for (const link of db.taskLinks(undefined, args.includes("--active"))) {
        process.stdout.write(`${link.task}\t${link.issue}\t${link.role}\t${link.harness ?? "-"}\t${link.torn_down_at ?? "active"}\n`);
      }
      return 0;
    }
    process.stderr.write("Usage: fm-linear task link|close|list\n");
    return 2;
  } finally { db.close(); }
}
