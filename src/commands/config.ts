import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { configPath, effectiveConfig, loadConfig, loadConfigFile } from "../config/load.ts";
import { atomicWriteFile, ensurePrivateDir } from "../fsutil.ts";

export function runConfig(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const sub = args[0] ?? "show";
  if (sub === "show" && (args[1] === "--effective" || args.length === 1)) {
    const config = loadConfig(env);
    process.stdout.write(`${JSON.stringify(effectiveConfig(config), null, 2)}\n`);
    return 0;
  }
  if (sub === "import") {
    const source = args[1];
    if (!source) {
      process.stderr.write("Usage: fm-linear config import <dir>\n");
      return 2;
    }
    const main = join(source, "linear-workflow.yaml");
    loadConfigFile(main);
    const destination = dirname(configPath(env));
    ensurePrivateDir(destination);
    const allowed = new Set(["linear-workflow.yaml", "reply.md", "report.md", "review-walkthrough.html", "output-style.md"]);
    for (const name of readdirSync(source)) {
      if (allowed.has(name) && existsSync(join(source, name))) {
        atomicWriteFile(join(destination, name), readFileSync(join(source, name), "utf8"), 0o600);
      }
    }
    process.stdout.write(`fm-linear config import: imported ${basename(source)}\n`);
    return 0;
  }
  process.stderr.write("Usage: fm-linear config show --effective | config import <dir>\n");
  return 2;
}
