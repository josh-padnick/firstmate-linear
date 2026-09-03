import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadConfigFile } from "./load.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function yaml(team = "ABC"): string {
  return `version: 1\ncaptain: { display_name: Captain }\nteams:\n  - key: ${team}\n    projects: []\nfeatures: { relay: shadow, mirror: shadow, escalation: shadow }\ntemplates: { reply: reply.md, report: report.md, review_walkthrough: review.html }\n`;
}

describe("v6 config", () => {
  test("managed scope defaults to assignee:self", () => {
    const root = mkdtempSync("/private/tmp/fml-config-"); roots.push(root);
    const path = join(root, "config.yaml"); writeFileSync(path, yaml());
    expect(loadConfigFile(path).teams[0]?.managed).toBe("assignee:self");
  });

  test("an invalid edit keeps the last-known-good config active", () => {
    const home = mkdtempSync("/private/tmp/fml-config-"); roots.push(home); mkdirSync(join(home, "config"));
    const path = join(home, "config", "linear-workflow.yaml"); writeFileSync(path, yaml("ABC"));
    expect(loadConfig({ FM_HOME: home }).teams[0]?.key).toBe("ABC");
    writeFileSync(path, "version: nope\n");
    expect(loadConfig({ FM_HOME: home }).teams[0]?.key).toBe("ABC");
  });

  test("a second team is an independent config block", () => {
    const root = mkdtempSync("/private/tmp/fml-config-"); roots.push(root);
    const path = join(root, "config.yaml");
    writeFileSync(path, yaml("ABC").replace("    projects: []", "    projects: [alpha]").replace("features:", "  - key: FAC\n    projects: [fabrica]\n    managed: assignee:self\nfeatures:"));
    const config = loadConfigFile(path);
    expect(config.teams.map((team) => team.key)).toEqual(["ABC", "FAC"]);
    expect(config.teams[1]?.projects).toEqual(["fabrica"]);
  });
});
