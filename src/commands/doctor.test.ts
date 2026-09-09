import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorExitCode, formatDoctor, runDoctorChecks } from "./doctor.ts";

describe("doctor", () => {
  test("required checks pass offline when a key file exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "fm-linear-doctor-"));
    mkdirSync(join(home, "config"));
    writeFileSync(join(home, ".env"), "LINEAR_API_KEY=fixture-key\n");
    writeFileSync(join(home, "config", "linear-workflow.yaml"), "version: 1\ncaptain: { display_name: Captain }\nteams:\n  - key: ABC\n    projects: []\n    managed: all\nfeatures: { relay: off, mirror: off, escalation: off }\ntemplates: { reply: reply.md, report: report.md, review_walkthrough: review.html }\n");
    const checks = await runDoctorChecks(["--offline"], { FM_HOME: home });
    expect(checks.filter((check) => check.required).every((check) => check.ok)).toBe(true);
    expect(doctorExitCode(checks)).toBe(0);
    const text = formatDoctor(checks);
    expect(text).toContain("ok  bun");
    expect(text).toContain("ok  key");
    expect(text).toContain("ok  parse-round-trip");
    expect(text).not.toContain("api");
  });

  test("missing key fails closed", async () => {
    const home = mkdtempSync(join(tmpdir(), "fm-linear-doctor-"));
    mkdirSync(join(home, "config"));
    writeFileSync(join(home, "config", "linear-workflow.yaml"), "version: 1\ncaptain: { display_name: Captain }\nteams:\n  - key: ABC\n    projects: []\n    managed: all\nfeatures: { relay: off, mirror: off, escalation: off }\ntemplates: { reply: reply.md, report: report.md, review_walkthrough: review.html }\n");
    const checks = await runDoctorChecks(["--offline"], { FM_HOME: home });
    expect(doctorExitCode(checks)).toBe(1);
    expect(checks.find((check) => check.name === "key")?.ok).toBe(false);
  });

  test("an invalid active config is named while last-known-good stays active", async () => {
    const home = mkdtempSync(join(tmpdir(), "fm-linear-doctor-"));
    mkdirSync(join(home, "config"));
    writeFileSync(join(home, ".env"), "LINEAR_API_KEY=fixture-key\n");
    const path = join(home, "config", "linear-workflow.yaml");
    writeFileSync(path, "version: 1\ncaptain: { display_name: Captain }\nteams:\n  - key: ABC\n    projects: []\nfeatures: { relay: off, mirror: off, escalation: off }\ntemplates: { reply: reply.md, report: report.md, review_walkthrough: review.html }\n");
    await runDoctorChecks(["--offline"], { FM_HOME: home });
    writeFileSync(path, "version: invalid\n");
    const checks = await runDoctorChecks(["--offline"], { FM_HOME: home });
    const config = checks.find((check) => check.name === "config");
    expect(config?.ok).toBe(true);
    expect(config?.detail).toContain("using last-known-good");
  });
});
