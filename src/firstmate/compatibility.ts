import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { commandEnvironment, runCommand } from "../support/command";
import { FmError } from "../support/errors";
import { runBriefProbe } from "./brief-probe";
import { ADAPTER_VERSION, getFirstmateInstallation, SUITE_VERSION } from "./installation";
import { IsolatedFirstmate } from "./isolation";
import { messageProbe } from "./message-probe";
import { EXTENSION_ADAPTER, EXTENSION_ID, EXTENSION_VERSION } from "./messages";
import type { AdapterStore } from "./store";
import { TaskStateProbeError, taskStateProbe } from "./task-probe";
import type {
  Capability,
  CapabilityCheck,
  FirstmateInstallation,
  FirstmateInstallationCheck,
} from "./types";
import { InstallationCheckSchema } from "./types";

export async function testFirstmateInstallation(
  installation: FirstmateInstallation,
  store: AdapterStore,
  selected: Capability[] = ["task-state", "briefs", "messages"],
): Promise<FirstmateInstallationCheck> {
  const before = await getFirstmateInstallation(installation);
  const capabilities: CapabilityCheck[] = [];
  let fixture: IsolatedFirstmate | null = null;
  try {
    fixture = await IsolatedFirstmate.create(before.codeRoot);
  } catch {
    for (const capability of selected)
      capabilities.push({
        capability,
        status: "not-verified",
        evidence: ["Operating-system isolation or its prerequisites could not be verified."],
      });
  }
  if (fixture)
    try {
      for (const capability of selected) {
        try {
          if (capability === "task-state") {
            const observations = await taskStateProbe(fixture);
            capabilities.push({
              capability,
              status: "passed",
              evidence: [
                "Exercised the installed state query and FM Linear task reader with a synthetic local Claude/scout task and a fake readable tmux endpoint. Verified task identity and attempts, working-to-parked transition, stale incarnation evidence, missing lifecycle evidence, and removed metadata. Live agents, other backends, remote tasks, and no-mistakes run attribution are not covered.",
                ...observations.map(
                  (observation) =>
                    `${observation.check}: ${observation.snapshot.activity.state} (${observation.snapshot.activity.source})`,
                ),
              ],
            });
          } else if (capability === "briefs") {
            await runBriefProbe(fixture);
            capabilities.push({
              capability,
              status: "passed",
              evidence: [
                "Exercised authored-brief creation, overwrite refusal, launch-copy preservation and spawn generation with a fake tmux harness. Only ship/local-only launch is covered.",
              ],
            });
          } else {
            const binding = await runCommand(
              "/bin/bash",
              [
                join(before.codeRoot, "bin/fm-extension.sh"),
                "resolve-process-event",
                EXTENSION_ADAPTER,
              ],
              { cwd: before.home, env: commandEnvironment(before.home, before.codeRoot) },
            );
            const fields = binding.stdout.trim().split("\t");
            if (
              binding.code !== 0 ||
              fields[0] !== "fm-extension-process-event-resolution.v1" ||
              fields.length !== 6 ||
              fields[1] !== EXTENSION_ID ||
              fields[2] !== EXTENSION_VERSION ||
              fields[3] !== "1"
            ) {
              capabilities.push({
                capability,
                status: "failed",
                evidence: [
                  "The selected home's FM Linear extension binding could not be resolved and handshaken. Bind a valid package before enabling messages.",
                ],
              });
              continue;
            }
            await messageProbe(fixture);
            capabilities.push({
              capability,
              status: "passed",
              evidence: [
                "Verified the selected home's bound extension and handshake, then used an isolated home to capture and classify a contextual request, verify one capture after retry, and retain a correlated response after reopening SQLite. Agent interpretation and workflow resolution are separate.",
              ],
            });
          }
        } catch (error) {
          capabilities.push({
            capability,
            status: "failed",
            evidence: [
              error instanceof TaskStateProbeError
                ? error.message
                : "The isolated contract exceeded its bound or could not execute.",
            ],
          });
        }
      }
    } finally {
      await fixture.close();
    }
  const after = await getFirstmateInstallation(installation);
  if (before.fingerprint !== after.fingerprint)
    for (const check of capabilities) {
      check.status = "not-verified";
      check.evidence = ["Installation changed during the check; rerun against settled inputs."];
    }
  const report: FirstmateInstallationCheck = {
    schemaVersion: 1,
    checkId: randomUUID(),
    installation: before,
    adapterVersion: ADAPTER_VERSION,
    suiteVersion: SUITE_VERSION,
    checkedAt: new Date().toISOString(),
    capabilities,
  };
  const prior = store.get<FirstmateInstallationCheck>(
    before.homeId,
    "compatibility",
    before.fingerprint,
  );
  const retained = prior?.capabilities.filter((c) => !selected.includes(c.capability)) ?? [];
  store.put(before.homeId, "compatibility", before.fingerprint, {
    ...report,
    capabilities: [...retained, ...capabilities],
  });
  return report;
}
export async function requireCapability(
  installation: FirstmateInstallation,
  store: AdapterStore,
  capability: Capability,
) {
  const current = await getFirstmateInstallation(installation);
  const report = store.get<FirstmateInstallationCheck>(
    installation.homeId,
    "compatibility",
    current.fingerprint,
  );
  if (
    !InstallationCheckSchema.safeParse(report).success ||
    !report ||
    report.capabilities.find((c) => c.capability === capability)?.status !== "passed"
  )
    throw new FmError(
      "firstmate.capability_held",
      "The current installation has no passing check for this capability.",
      "not-attempted",
    );
  return current;
}
