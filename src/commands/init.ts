import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath, loadConfigFile } from "../config/load.ts";
import { StateDatabase } from "../db/database.ts";
import { resolveHome } from "../env.ts";
import { atomicWriteFile, ensurePrivateDir } from "../fsutil.ts";
import { ASSETS } from "../assets.ts";
import { optionValue } from "./args.ts";

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
  if (!existsSync(destination)) {
    if (!captainInput || !teamInput) {
      process.stderr.write("fm-linear init: --captain NAME and --team KEY are required for a new config\n");
      return 2;
    }
    ensurePrivateDir(join(home, "config"));
    ensurePrivateDir(join(home, "state", "linear"));
    const rendered = ASSETS.configExample
      .replace("CAPTAIN_NAME", JSON.stringify(captainInput))
      .replace("key: TEAM", `key: ${JSON.stringify(teamInput)}`);
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
