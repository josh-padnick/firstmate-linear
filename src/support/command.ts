import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { FmError } from "./errors";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
// Labels are authored here, never derived from private argv, paths, or child output.
const operations = {
  "fleet-read": {
    label: "Firstmate's fleet read",
    nextAction:
      "Check the registered home's availability and retry. Previous observations remain last-known.",
  },
  command: {
    label: "The Firstmate command",
    nextAction: "Run fm-linear test with the same required options.",
  },
  "task-state": {
    label: "Firstmate's task-state query",
    nextAction: "Run fm-linear test --capability task-state with the same required options.",
  },
  "message-registration": {
    label: "Firstmate's message-source registration",
    nextAction: "Inspect the saved message's registration in Firstmate before retrying.",
  },
} as const;

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs?: number;
    limit?: number;
    operation?: keyof typeof operations;
  },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const operation = operations[options.operation ?? "command"];
    const timeoutMs = options.timeoutMs ?? 10000;
    const outputLimit = options.limit ?? 128 * 1024;
    const effect = options.operation === "message-registration" ? "unknown" : "not-applicable";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[][] = [[], []];
    let bytes = 0;
    let stopped: "timeout" | "output" | undefined;
    const terminate = (reason: "timeout" | "output") => {
      if (stopped) return;
      stopped = reason;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    };
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    [child.stdout, child.stderr].forEach((stream, index) => {
      stream.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > outputLimit) terminate("output");
        else chunks[index]?.push(data);
      });
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(
        new FmError(
          "firstmate.command_failed",
          `${operation.label} could not start.`,
          effect === "unknown" ? "not-attempted" : effect,
          "Check that Firstmate's required command-line tools are installed and available on PATH.",
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stopped)
        return reject(
          new FmError(
            stopped === "timeout"
              ? "firstmate.command_timed_out"
              : "firstmate.command_output_limit",
            stopped === "timeout"
              ? `${operation.label} timed out after ${timeoutMs / 1000} seconds.`
              : `${operation.label} exceeded its output limit of ${outputLimit} bytes and was stopped.`,
            effect,
            operation.nextAction,
          ),
        );
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(chunks[0] ?? []).toString(),
        stderr: Buffer.concat(chunks[1] ?? []).toString(),
      });
    });
  });
}
const systemPath =
  "/Library/Developer/CommandLineTools/usr/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export function commandEnvironment(
  home: string,
  root: string,
  options: { isolated?: boolean } = {},
): Record<string, string> {
  return {
    PATH: options.isolated ? systemPath : process.env.PATH || systemPath,
    HOME: options.isolated ? home : process.env.HOME || homedir(),
    FM_HOME: home,
    FM_ROOT_OVERRIDE: root,
    FM_STATE_OVERRIDE: `${home}/state`,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}
