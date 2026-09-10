import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FmError } from "../support/errors";
import { hash } from "../support/files";
import { instructionBlock } from "./briefs";
import { childRoute } from "./fleet";
import { FleetReader } from "./fleet-reader";
import { parseFleet } from "./fleet-schema";
import { FleetStore } from "./fleet-store";
import { getFirstmateInstallation } from "./installation";
import type { IsolatedFirstmate } from "./isolation";
import { checkRoutedBrief, readRoutedTask } from "./routed-task";
import { AdapterStore } from "./store";
import { AttemptId, TaskId } from "./types";

/** Real producer and router; only SSH is replaced with a local transport boundary. */
export async function fleetProbe(fixture: IsolatedFirstmate, routed = false) {
  const child = join(fixture.root, "child");
  await mkdir(join(child, "state"), { recursive: true });
  await mkdir(join(child, "data"), { recursive: true });
  await mkdir(join(fixture.home, "data"), { recursive: true });
  for (let i = 0; i < 25; i++)
    await writeFile(
      join(child, "state", `child-${i}.meta`),
      `kind=scout\nharness=claude\nspawn_gen=attempt-${i}\n`,
    );
  const worktree = join(child, "worktree");
  await mkdir(worktree, { recursive: true });
  await writeFile(
    join(fixture.root, "tools", "tmux"),
    '#!/bin/sh\nif [ "$1" = display-message ]; then printf "%s\\n" "%1"; exit 0; fi\nexit 97\n',
    { mode: 0o700 },
  );
  await writeFile(
    join(child, "state", "child-24.meta"),
    `kind=scout\nharness=claude\nbackend=tmux\nwindow=fm:probe\nspawn_gen=attempt-24\nworktree=${worktree}\n`,
  );
  const armed = await fixture.run(
    "/bin/bash",
    [join(fixture.codeRoot, "bin/fm-busy-event.sh"), "arm", join(child, "state"), "child-24"],
    { FM_HOME: child, FM_STATE_OVERRIDE: join(child, "state") },
  );
  if (armed.code !== 0)
    throw new FmError(
      "firstmate.contract_failed",
      "The fleet fixture could not establish a known working task.",
    );
  await writeFile(
    join(child, "data", "backlog.md"),
    "## Queued\n- [ ] queued-task - A queued task (kind: scout)\n",
  );
  const local = await fixture.run(
    "/bin/bash",
    [join(fixture.codeRoot, "bin/fm-fleet-snapshot.sh"), "--json"],
    {
      FM_HOME: child,
      FM_STATE_OVERRIDE: join(child, "state"),
    },
  );
  if (local.code !== 0)
    throw new FmError(
      "firstmate.contract_failed",
      "The fleet producer could not run in isolation.",
    );
  const doc = parseFleet(local.stdout);
  if (
    doc.tasks.length !== 25 ||
    doc.tasks[24]?.spawn_gen === null ||
    !doc.backlog.records.some((r) => r.id === "queued-task")
  )
    throw new FmError(
      "firstmate.contract_failed",
      "The full fleet read lost task or backlog inventory.",
    );
  if (!routed) return doc;

  await writeFile(
    join(fixture.home, "data", "secondmates.md"),
    `- probe-child - Fixture (host: fixture-host; root: ${fixture.codeRoot}; home: ${child}; scope: testing; projects: ; added 2026-09-10)\n`,
  );
  for (const args of [
    ["init", "-q"],
    ["add", "bin"],
  ]) {
    const result = await fixture.run("/usr/bin/git", ["-C", fixture.codeRoot, ...args]);
    if (result.code !== 0)
      throw new FmError(
        "firstmate.contract_failed",
        "The route fixture could not track its copied scripts.",
      );
  }
  const ssh = join(fixture.root, "tools", "ssh");
  await writeFile(
    ssh,
    `#!/bin/bash
set -eu
while [ "$1" != -- ]; do shift; done
shift 2
entry=$1; shift
test "$entry" = fm-remote-entrypoint.sh
test "$1" = 1
root=$(printf %s "$2" | base64 --decode)
home=$(printf %s "$3" | base64 --decode)
args=()
while IFS= read -r -d '' arg; do args+=("$arg"); done < <(printf %s "$4" | base64 --decode)
export FM_HOME="$home" FM_ROOT_OVERRIDE="$root" FM_STATE_OVERRIDE="$home/state"
exec /bin/bash "$root/bin/\${args[0]}" "\${args[@]:1}"
`,
  );
  await chmod(ssh, 0o755);
  const remote = await fixture.run("/bin/bash", [
    join(fixture.codeRoot, "bin/fm-on.sh"),
    "probe-child",
    "fm-fleet-snapshot.sh",
    "--json",
  ]);
  if (remote.code !== 0)
    throw new FmError(
      "firstmate.contract_failed",
      "The registered route could not read a full child inventory.",
    );
  const remoteDoc = parseFleet(remote.stdout);
  if (remoteDoc.fm_home !== child || remoteDoc.tasks.length !== 25)
    throw new FmError(
      "firstmate.contract_failed",
      "The registered route read a different or incomplete home.",
    );
  const primary = await fixture.run("/bin/bash", [
    join(fixture.codeRoot, "bin/fm-fleet-snapshot.sh"),
    "--json",
  ]);
  const primaryDoc = parseFleet(primary.stdout);
  const row = primaryDoc.secondmate_current.registry.records.find((r) => r.id === "probe-child");
  if (primary.code !== 0 || !row)
    throw new FmError(
      "firstmate.contract_failed",
      "The primary snapshot did not discover the registered child.",
    );
  const installation = await getFirstmateInstallation({
    home: fixture.home,
    codeRoot: fixture.codeRoot,
  });
  const store = new AdapterStore(join(fixture.root, "fleet-probe", "state.sqlite"));
  try {
    const route = new FleetStore(store, installation.homeId).bind(childRoute(installation, row));
    const reader = new FleetReader(installation, (home, command, args, timeoutMs) =>
      fixture.run(
        "/bin/bash",
        [join(fixture.codeRoot, "bin", command), ...args],
        { FM_HOME: home, FM_STATE_OVERRIDE: join(home, "state") },
        timeoutMs,
      ),
    );
    store.put(installation.homeId, "fleet", "registry-revision", {
      revision: await reader.registryRevision(),
    });
    const task = { homeId: route.owner.homeId, taskId: TaskId.parse("child-24") };
    const snapshot = await readRoutedTask(installation, store, route, task, reader);
    if (
      snapshot.presence !== "found" ||
      snapshot.attempt?.attemptId !== "attempt-24" ||
      snapshot.activity.state !== "working"
    )
      throw new FmError(
        "firstmate.contract_failed",
        "The routed task read lost its owning home or execution generation.",
      );
    const text = instructionBlock("Create a review recap.", "v1");
    await mkdir(join(child, "data", "child-24"), { recursive: true });
    await writeFile(join(child, "data", "child-24", "launch-brief.md"), text);
    const check = await checkRoutedBrief(
      installation,
      store,
      route,
      {
        receiptId: crypto.randomUUID(),
        task,
        previousRevision: hash(""),
        revision: hash(text),
        instructionVersion: "v1",
        instructionDigest: hash(text),
        updatedAt: new Date().toISOString(),
      },
      { task, attemptId: AttemptId.parse("attempt-24") },
      reader,
    );
    if (check.status !== "included")
      throw new FmError(
        "firstmate.contract_failed",
        "The routed launch-brief read did not verify the expected instruction block.",
      );
  } finally {
    store.close();
  }
  return remoteDoc;
}
