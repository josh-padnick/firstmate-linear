import { join } from "node:path";
import { loadConfig } from "../config/load.ts";
import { resolveHome } from "../env.ts";
import { checkReview, scaffoldReview } from "../review/review.ts";

function flag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

export function runReview(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const sub = args[0];
  try {
    if (sub === "scaffold") {
      const issue = args[1];
      if (!issue) throw new Error("issue is required");
      const output = flag(args, "--output") ?? join(resolveHome(env), "data", issue.toLowerCase(), "review-walkthrough.html");
      const title = flag(args, "--title") ?? "Deliverable";
      const config = loadConfig(env);
      scaffoldReview({ issue, title, output, template: config.templates.review_walkthrough });
      process.stdout.write(`fm-linear review scaffold: ${output}\n`);
      return 0;
    }
    if (sub === "check") {
      const path = args[1];
      if (!path) throw new Error("walkthrough path is required");
      const errors = checkReview(path);
      if (errors.length) {
        process.stderr.write(`fm-linear review check: REFUSED\n${errors.map((item) => `  - ${item}`).join("\n")}\n`);
        return 1;
      }
      process.stdout.write(`fm-linear review check: ok ${path}\n`);
      return 0;
    }
    process.stderr.write("Usage: fm-linear review scaffold ISSUE [--output path] [--title text] | review check path\n");
    return 2;
  } catch (error) {
    process.stderr.write(`fm-linear review: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
