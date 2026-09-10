import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pollRequest } from "../src/firstmate/messages";
import { AdapterStore } from "../src/firstmate/store";
import { Diagnostic } from "../src/support/logging";

test("CLI schema failures preserve clean stdout and do not leak payload canaries", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fm-cli-")));
  try {
    await mkdir(join(root, "code/bin"), { recursive: true });
    await mkdir(join(root, "home"));
    await writeFile(join(root, "input.json"), '{"PRIVATE_COMMENT_CANARY":"secret"}');
    const child = Bun.spawn(
      [
        process.execPath,
        "src/cli.ts",
        "receive",
        "--home",
        join(root, "home"),
        "--code-root",
        join(root, "code"),
        "--state",
        join(root, "private/state.sqlite"),
        "--input",
        join(root, "input.json"),
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).not.toContain("PRIVATE_COMMENT_CANARY");
    expect(Diagnostic.parse(JSON.parse(stderr)).error.code).toBe("config.invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("a process killed immediately after durable acceptance retains the exact request", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fm-crash-")));
  try {
    await mkdir(join(root, "home"));
    const database = join(root, "private/state.sqlite");
    const modulePath = JSON.stringify(resolve("src/firstmate/messages.ts"));
    const storePath = JSON.stringify(resolve("src/firstmate/store.ts"));
    const childFile = join(root, "crash.ts");
    await writeFile(
      childFile,
      `import {sendMessage} from ${modulePath};import {AdapterStore} from ${storePath};const store=new AdapterStore(process.argv[2]);await sendMessage({homeId:'home',home:process.argv[3],codeRoot:process.argv[3]},store,{requestId:'durable',destination:{kind:'home',homeId:'home'},text:'Survive the crash',context:'',expectedResponse:'text'},async()=>{process.kill(process.pid,'SIGKILL');await new Promise(()=>{});});`,
    );
    const child = Bun.spawn([process.execPath, childFile, database, join(root, "home")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).not.toBe(0);
    const store = new AdapterStore(database, { existing: true });
    try {
      const record = JSON.parse(pollRequest(store, "home", "durable", "host-1").output);
      expect(record.text).toBe("Survive the crash");
      expect(record.requestId).toBe("durable");
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI formats preserve result data, error codes, and output streams", async () => {
  // Catches: human text contaminating machine output or format selection losing error semantics.
  const { decode } = await import("@toon-format/toon");
  const root = await realpath(await mkdtemp(join(tmpdir(), "fm-cli-formats-")));
  const invoke = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  };
  try {
    await mkdir(join(root, "code/bin"), { recursive: true });
    await mkdir(join(root, "home"));
    const paths = [
      "--home",
      join(root, "home"),
      "--code-root",
      join(root, "code"),
      "--state",
      join(root, "state.sqlite"),
    ];
    const machineResults: unknown[] = [];
    for (const format of ["human", "json", "toon"] as const) {
      const flags = format === "human" ? [] : ["--format", format];
      const success = await invoke(["installation", ...paths, ...flags]);
      expect(success.code).toBe(0);
      expect(success.stderr).toBe("");
      expect(success.stdout).not.toContain("\x1b");
      if (format === "human") {
        expect(success.stdout).toContain(`Home: ${join(root, "home")}`);
        expect(success.stdout).toStartWith("Firstmate installation\n");
      } else
        machineResults.push(
          format === "json" ? JSON.parse(success.stdout) : decode(success.stdout),
        );
      for (const badArgs of [["installation"], ["installation", "--unknown-option"]]) {
        const failure = await invoke([...badArgs, ...flags]);
        expect(failure.code).toBe(2);
        expect(failure.stdout).toBe("");
        if (format === "human") {
          expect(failure.stderr).toStartWith("Error:");
          expect(failure.stderr).toContain(
            badArgs.length === 1 ? "fm-linear installation --help" : "fm-linear --help",
          );
        } else {
          const diagnostic = Diagnostic.parse(
            format === "json" ? JSON.parse(failure.stderr) : decode(failure.stderr),
          );
          expect(diagnostic.error.code).toBe("config.invalid");
        }
      }
    }
    expect(machineResults[0]).toEqual(machineResults[1]);
    const legacy = await invoke(["installation", ...paths, "--json"]);
    expect(JSON.parse(legacy.stdout)).toEqual(machineResults[0]);
    for (const flags of [
      ["--format", "invalid"],
      ["--json", "--format", "toon"],
    ]) {
      const failure = await invoke(["installation", ...paths, ...flags]);
      expect(failure.code).toBe(2);
      expect(failure.stdout).toBe("");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compatibility failures keep exit 1 in every CLI format", async () => {
  // Catches: a readable result being mistaken for success when a capability is not verified.
  const { decode } = await import("@toon-format/toon");
  const root = await realpath(await mkdtemp(join(tmpdir(), "fm-cli-status-")));
  try {
    await mkdir(join(root, "code/bin"), { recursive: true });
    await mkdir(join(root, "home"));
    const preload = join(root, "check.ts");
    await writeFile(
      preload,
      `import {FirstmateAdapter} from ${JSON.stringify(resolve("src/firstmate/adapter.ts"))};
FirstmateAdapter.prototype.testFirstmateInstallation = async function () {
return {schemaVersion:1,checkId:crypto.randomUUID(),installation:this.installation,adapterVersion:'test',suiteVersion:'2',checkedAt:new Date().toISOString(),capabilities:[{capability:'task-state',status:'not-verified',evidence:['Fixture prerequisites unavailable.']}]};
};`,
    );
    for (const format of ["human", "json", "toon"]) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          preload,
          "src/cli.ts",
          "test",
          "--home",
          join(root, "home"),
          "--code-root",
          join(root, "code"),
          "--state",
          join(root, "state.sqlite"),
          "--format",
          format,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(1);
      expect(stderr).toBe("");
      if (format === "human") {
        expect(stdout).toContain("NOT VERIFIED  task-state");
        expect(stdout).toContain(join(root, "code"));
        expect(stdout).not.toContain("All selected checks passed.");
      } else {
        const report = (format === "json" ? JSON.parse(stdout) : decode(stdout)) as {
          capabilities: { status: string }[];
        };
        expect(report.capabilities[0]?.status).toBe("not-verified");
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
