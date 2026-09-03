import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath, loadConfigFile } from "../config/load.ts";
import { StateDatabase } from "../db/database.ts";
import { resolveHome } from "../env.ts";
import { atomicWriteFile, ensurePrivateDir } from "../fsutil.ts";
import { ASSETS } from "../assets.ts";


function value(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? null : null;
}

export function runInit(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const home = resolveHome(env);
  const destination = configPath(env);
  ensurePrivateDir(join(home, "config"));
  ensurePrivateDir(join(home, "state", "linear"));
  if (!existsSync(destination)) {
    const captain = value(args, "--captain") ?? env.FM_LINEAR_CAPTAIN_NAME?.trim();
    const team = value(args, "--team")?.toUpperCase();
    if (!captain || !team) {
      process.stderr.write("fm-linear init: --captain NAME and --team KEY are required for a new config\n");
      return 2;
    }
    const rendered = ASSETS.configExample
      .replace("CAPTAIN_NAME", captain)
      .replace("key: TEAM", `key: ${team}`);
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
  const captainPath = join(home, "data", "captain.md");
  const start = "<!-- fm-linear:start -->";
  const end = "<!-- fm-linear:end -->";
  const snippet = ASSETS.captainSnippet.trim();
  let captain = "";
  try { captain = readFileSync(captainPath, "utf8"); } catch { captain = ""; }
  const block = `${start}\n${snippet}\n${end}`;
  const pattern = /<!-- fm-linear:start -->[\s\S]*?<!-- fm-linear:end -->/;
  const updated = pattern.test(captain) ? captain.replace(pattern, block) : `${captain.trimEnd()}${captain.trim() ? "\n\n" : ""}${block}\n`;
  atomicWriteFile(captainPath, updated.endsWith("\n") ? updated : `${updated}\n`, 0o600);
  const db = StateDatabase.open(env);
  db.close();
  process.stdout.write(`fm-linear init: ready at ${home}\nconfig: ${destination}\n`);
  return 0;
}
