import { spawn } from "node:child_process";
import { FmError } from "./errors";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs?: number;
    limit?: number;
  },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[][] = [[], []];
    let bytes = 0;
    let stopped = false;
    const terminate = () => {
      stopped = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    };
    const timer = setTimeout(terminate, options.timeoutMs ?? 10000);
    [child.stdout, child.stderr].forEach((stream, index) => {
      stream.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > (options.limit ?? 128 * 1024)) terminate();
        else chunks[index]?.push(data);
      });
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new FmError("firstmate.command_failed", "The command could not start."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stopped)
        return reject(
          new FmError(
            "firstmate.command_failed",
            "The command exceeded its execution or output bound.",
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
export function commandEnvironment(home: string, root: string): Record<string, string> {
  return {
    PATH: "/Library/Developer/CommandLineTools/usr/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
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
