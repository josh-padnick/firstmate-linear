import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadConfigFile } from "../config/load.ts";
import { GATE_ROLES } from "../config/schema.ts";
import { testWorkflowConfig } from "../testing/config.ts";
import { resolveSignalRole } from "./roles.ts";

const SIGNALS = ["needs-decision", "pr-green", "dispatch-scout", "dispatch", "lane-cap", "blocked", "failed", "pr-merged"] as const;

function expectSignalsResolve(config: ReturnType<typeof testWorkflowConfig>): void {
  const team = config.teams[0]!;
  for (const signal of SIGNALS) {
    const result = resolveSignalRole(team, signal);
    if (result.kind === "move") expect(team.roles[result.role]).toBeTruthy();
    else expect(result).toEqual({ kind: "stay", comment: true });
  }
}

test("every signal in a zero-gate workflow resolves to a mapped role or stay", () => {
  const config = testWorkflowConfig({ roles: { building: "In Progress", done: "Done", canceled: "Canceled" } });
  const team = config.teams[0]!;
  expectSignalsResolve(config);
  expect(resolveSignalRole(team, "dispatch-scout")).toEqual({ kind: "move", role: "building" });
  expect(resolveSignalRole(team, "pr-merged")).toEqual({ kind: "move", role: "done" });
});

test("the shipped one-gate and four-gate examples resolve every signal", () => {
  const minimal = loadConfigFile(fileURLToPath(new URL("../../examples/minimal.yaml", import.meta.url)));
  const full = loadConfigFile(fileURLToPath(new URL("../../examples/full.yaml", import.meta.url)));
  expect(GATE_ROLES.filter((role) => minimal.teams[0]!.roles[role])).toEqual(["review-gate"]);
  expect(GATE_ROLES.filter((role) => full.teams[0]!.roles[role])).toEqual(["plan-gate", "review-gate", "merge-gate"]);
  expectSignalsResolve(minimal);
  expectSignalsResolve(full);
});
