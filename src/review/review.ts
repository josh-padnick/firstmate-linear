import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../fsutil.ts";
import { ASSETS } from "../assets.ts";

export const REQUIRED_SECTIONS = ["outcome", "changes", "verification", "review"] as const;

export function scaffoldReview(options: { issue: string; title: string; output: string; template?: string }): string {
  if (existsSync(options.output)) throw new Error(`refusing to overwrite existing walkthrough: ${options.output}`);
  const source = options.template ? readFileSync(options.template, "utf8") : ASSETS.reviewTemplate;
  const text = source
    .replaceAll("{{issue}}", options.issue)
    .replaceAll("{{title}}", options.title)
    .replaceAll("{{outcome}}", "TODO: State the user-visible outcome.")
    .replaceAll("{{changes}}", "TODO: Summarize the meaningful changes.")
    .replaceAll("{{verification}}", "TODO: List checks and evidence.")
    .replaceAll("{{review}}", "TODO: Give a cold reviewer exact review steps.");
  atomicWriteFile(options.output, text, 0o600);
  return options.output;
}

export function checkReview(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const errors: string[] = [];
  for (const id of REQUIRED_SECTIONS) {
    if (!new RegExp(`id=["']${id}["']`).test(text)) errors.push(`missing required section #${id}`);
  }
  if (/\{\{[^}]+\}\}/.test(text)) errors.push("unresolved template placeholder");
  if (/\b(?:TODO|PLACEHOLDER|TBD)\b/i.test(text)) errors.push("placeholder content remains");
  return errors;
}
