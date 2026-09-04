import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateDatabase } from "../db/database.ts";
import { runContract } from "./contract.ts";
import { runInit } from "./init.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("contract commands", () => {
  test("init validates option values before writing and safely serializes YAML scalars", () => {
    const bad = mkdtempSync("/private/tmp/fml-init-"); roots.push(bad);
    expect(runInit(["--captain", "--team", "ABC"], { FM_HOME: bad })).toBe(2);
    expect(existsSync(join(bad, "config"))).toBe(false);
    const home = mkdtempSync("/private/tmp/fml-init-"); roots.push(home);
    expect(runInit(["--captain", "Josh: Admin", "--team", "ABC"], { FM_HOME: home })).toBe(0);
    const parsed = Bun.YAML.parse(readFileSync(join(home, "config", "linear-workflow.yaml"), "utf8")) as { captain: { display_name: string } };
    expect(parsed.captain.display_name).toBe("Josh: Admin");
  });

  test("init rejects malformed or incomplete discovered role maps before writing", () => {
    for (const roleMap of ["{", JSON.stringify({ building: "Building" })]) {
      const home = mkdtempSync("/private/tmp/fml-init-"); roots.push(home);
      expect(runInit(["--captain", "Captain", "--team", "ABC"], { FM_HOME: home, FM_LINEAR_INIT_ROLE_MAP: roleMap })).toBe(1);
      expect(existsSync(join(home, "config", "linear-workflow.yaml"))).toBe(false);
    }
  });

  test("contract lint rejects missing, unsupported, and malformed template contracts", () => {
    const home = mkdtempSync("/private/tmp/fml-contract-"); roots.push(home);
    expect(runInit(["--captain", "Captain", "--team", "ABC"], { FM_HOME: home })).toBe(0);
    expect(runContract(["lint"], { FM_HOME: home })).toBe(0);
    writeFileSync(join(home, "config", "reply.md"), "{{body}} {{unsupported}}\n");
    rmSync(join(home, "config", "report.md"));
    writeFileSync(join(home, "config", "review-walkthrough.html"), "<section id=\"outcome\">{{issue}} {{title}}</section>\n");
    expect(runContract(["lint"], { FM_HOME: home })).toBe(1);
  });

  test("contract reconciliation revives terminal checks", () => {
    const home = mkdtempSync("/private/tmp/fml-contract-"); roots.push(home);
    expect(runInit(["--captain", "Captain", "--team", "ABC"], { FM_HOME: home })).toBe(0);
    expect(runContract(["apply-labels"], { FM_HOME: home })).toBe(0);
    let db = StateDatabase.open({ FM_HOME: home });
    const job = db.jobs()[0]!;
    db.finishJob(job.id);
    db.close();
    expect(runContract(["apply-labels"], { FM_HOME: home })).toBe(0);
    db = StateDatabase.open({ FM_HOME: home });
    expect(db.jobs()[0]).toMatchObject({ state: "pending", attempts: 0, done_at: null });
    db.close();
  });

  test("apply-states creates only one explicitly approved role", () => {
    const home = mkdtempSync("/private/tmp/fml-contract-"); roots.push(home);
    expect(runInit(["--captain", "Captain", "--team", "ABC"], { FM_HOME: home })).toBe(0);
    expect(runContract(["apply-states", "--team", "ABC", "--role", "decision-captain", "--name", "Needs Decision", "--yes"], { FM_HOME: home })).toBe(0);
    const db = StateDatabase.open({ FM_HOME: home });
    expect(db.jobs()).toHaveLength(1);
    expect(JSON.parse(db.jobs()[0]!.payload)).toMatchObject({ team: "ABC", role: "decision-captain", name: "Needs Decision" });
    db.close();
  });
});
