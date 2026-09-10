import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("live commands find user-installed tools and their home without inheriting unrelated variables", async () => {
  // Catches: a sanitized environment hiding the user's harness binary or its session files.
  const root = await mkdtemp(join(tmpdir(), "fm-command-"));
  try {
    const userHome = join(root, "user");
    const fmHome = join(root, "firstmate");
    const bin = join(root, "bin");
    await Promise.all([mkdir(userHome), mkdir(fmHome), mkdir(bin)]);
    await writeFile(join(userHome, "session"), "working");
    const harness = join(bin, "fixture-harness");
    await writeFile(harness, '#!/bin/sh\n/bin/cat "$HOME/session"\n');
    await chmod(harness, 0o700);
    const runner = join(root, "check.ts");
    await writeFile(
      runner,
      `import {commandEnvironment, runCommand} from ${JSON.stringify(resolve("src/support/command.ts"))};
const env = commandEnvironment(process.argv[2], process.argv[2]);
const result = await runCommand('/bin/sh', ['-c', 'fixture-harness'], {cwd:process.argv[2], env});
console.log(JSON.stringify({result, fmHome:env.FM_HOME, leaked:env.PRIVATE_CANARY ?? null}));`,
    );
    const child = Bun.spawn([process.execPath, runner, fmHome], {
      env: {
        ...process.env,
        HOME: userHome,
        PATH: `${bin}:/usr/bin:/bin`,
        PRIVATE_CANARY: "private",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toEqual({
      result: { code: 0, stdout: "working", stderr: "" },
      fmHome,
      leaked: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command bounds distinguish timeout from excessive output without exposing command contents", async () => {
  const { runCommand, commandEnvironment } = await import("../src/support/command");
  const { FmError, ErrorRecord } = await import("../src/support/errors");
  const cases = [
    {
      args: ["-c", "exec /bin/sleep 5", "PRIVATE_ARGUMENT_CANARY"],
      options: { timeoutMs: 100 },
      code: "firstmate.command_timed_out",
      summary: "Firstmate's task-state query timed out after 0.1 seconds.",
    },
    {
      args: ["-c", "printf PRIVATE_OUTPUT_CANARY"],
      options: { limit: 8 },
      code: "firstmate.command_output_limit",
      summary: "Firstmate's task-state query exceeded its output limit of 8 bytes and was stopped.",
    },
  ] as const;
  for (const item of cases) {
    const error = await runCommand("/bin/sh", [...item.args], {
      cwd: tmpdir(),
      env: commandEnvironment(tmpdir(), tmpdir()),
      operation: "task-state",
      ...item.options,
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(FmError);
    if (!(error instanceof FmError)) throw new Error("Expected a command failure");
    const record = ErrorRecord.parse(error.toJSON());
    expect(record.code).toBe(item.code);
    expect(record.summary).toBe(item.summary);
    expect(record.nextAction).toBe(
      "Run fm-linear test --capability task-state with the same required options.",
    );
    expect(record.effect).toBe("not-applicable");
    expect(JSON.stringify(record)).not.toContain("PRIVATE_");
  }
});

test("registration failures preserve unknown effects after a timeout and no attempt after a spawn failure", async () => {
  const { runCommand, commandEnvironment } = await import("../src/support/command");
  const options = {
    cwd: tmpdir(),
    env: commandEnvironment(tmpdir(), tmpdir()),
    operation: "message-registration" as const,
    timeoutMs: 100,
  };
  await expect(runCommand("/bin/sleep", ["5"], options)).rejects.toMatchObject({
    code: "firstmate.command_timed_out",
    effect: "unknown",
  });
  await expect(runCommand("/nonexistent-fm-linear-command", [], options)).rejects.toMatchObject({
    code: "firstmate.command_failed",
    effect: "not-attempted",
  });
});

test("command failures render once on stderr in human, JSON, and TOON formats", async () => {
  const { decode } = await import("@toon-format/toon");
  const { Diagnostic } = await import("../src/support/logging");
  const root = await mkdtemp(join(tmpdir(), "fm-command-output-"));
  try {
    const runner = join(root, "failure.ts");
    await writeFile(
      runner,
      `import {runCommand, commandEnvironment} from ${JSON.stringify(resolve("src/support/command.ts"))};
import {printFailure} from ${JSON.stringify(resolve("src/cli-output.ts"))};
import {normalizeError} from ${JSON.stringify(resolve("src/support/errors.ts"))};
try {
  await runCommand('/bin/sh', ['-c', 'printf PRIVATE_OUTPUT_CANARY'], {
    cwd:process.cwd(), env:commandEnvironment(process.cwd(),process.cwd()),
    operation:'task-state', limit:8,
  });
} catch(error) {
  printFailure(normalizeError(error), process.argv[2]);
  process.exitCode=2;
}`,
    );
    for (const format of ["human", "json", "toon"]) {
      const child = Bun.spawn([process.execPath, runner, format], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).not.toContain("PRIVATE_OUTPUT_CANARY");
      if (format === "human") {
        expect(stderr.match(/Error:/g)).toHaveLength(1);
        expect(stderr).toContain(
          "Firstmate's task-state query exceeded its output limit of 8 bytes",
        );
        expect(stderr).toContain("Run fm-linear test --capability task-state");
      } else {
        const diagnostic = Diagnostic.parse(
          format === "json" ? JSON.parse(stderr) : decode(stderr),
        );
        expect(diagnostic.error.code).toBe("firstmate.command_output_limit");
        expect(diagnostic.error.nextAction).toContain("--capability task-state");
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
