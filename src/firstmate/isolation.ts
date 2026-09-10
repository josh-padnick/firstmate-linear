import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type CommandResult, commandEnvironment, runCommand } from "../support/command";
import { FmError } from "../support/errors";

export class IsolatedFirstmate {
  private constructor(
    readonly root: string,
    readonly codeRoot: string,
    readonly home: string,
    readonly command: string,
    readonly prefix: string[],
    readonly scratch: string,
  ) {}
  static async create(codeRoot: string): Promise<IsolatedFirstmate> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "fm-linear-probe-")));
    const code = join(root, "code");
    const home = join(root, "home");
    const scratch = await realpath(await mkdtemp("/tmp/fm-fml-probe-"));
    try {
      await mkdir(code);
      await mkdir(home);
      await mkdir(join(root, "tools"));
      if (process.platform === "darwin") {
        await cp("/bin/ps", join(root, "tools", "ps"));
        await chmod(join(root, "tools", "ps"), 0o755);
        const signed = await runCommand(
          "/usr/bin/codesign",
          ["--force", "--sign", "-", join(root, "tools", "ps")],
          { cwd: root, env: commandEnvironment(home, code, { isolated: true }) },
        );
        if (signed.code !== 0)
          throw new FmError(
            "firstmate.contract_failed",
            "The fixture process-query utility could not be signed.",
          );
      }
      await mkdir(join(root, "tmp"));
      await cp(join(codeRoot, "bin"), join(code, "bin"), { recursive: true, dereference: false });
      let command: string;
      let prefix: string[];
      if (process.platform === "darwin") {
        command = "/usr/bin/sandbox-exec";
        const profile = join(root, "probe.sb");
        const readPaths = [
          root,
          scratch,
          "/System",
          "/usr",
          "/bin",
          "/sbin",
          "/Library",
          "/private/var/db/dyld",
          "/private/etc",
          "/opt/homebrew",
          dirname(process.execPath),
          "/dev",
        ];
        const filters = readPaths.map((p) => `(subpath ${JSON.stringify(p)})`).join(" ");
        await writeFile(
          profile,
          `(version 1)\n(deny default)\n(allow process* sysctl-read mach-lookup ipc-posix-shm*)\n(allow signal (target same-sandbox))\n(allow file-read-metadata file-map-executable)\n(allow file-write-data (vnode-type 7))\n(allow file-read* (literal "/") ${filters})\n(allow file-write* (subpath ${JSON.stringify(root)}) (subpath ${JSON.stringify(scratch)}) (literal "/dev/null") (subpath "/dev/fd"))\n`,
        );
        prefix = ["-f", profile];
      } else if (process.platform === "linux" && existsSync("/usr/bin/bwrap")) {
        command = "/usr/bin/bwrap";
        prefix = [
          "--die-with-parent",
          "--unshare-all",
          "--new-session",
          "--proc",
          "/proc",
          "--dev",
          "/dev",
        ];
        for (const p of ["/usr", "/bin", "/sbin", "/lib", "/lib64", dirname(process.execPath)])
          if (existsSync(p)) prefix.push("--ro-bind", p, p);
        prefix.push("--bind", root, root, "--bind", scratch, scratch, "--chdir", home);
      } else
        throw new FmError(
          "firstmate.contract_failed",
          "Operating-system probe isolation is unavailable.",
        );
      const result = new IsolatedFirstmate(root, code, home, command, prefix, scratch);
      await result.verifyIsolation();
      return result;
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
      throw error;
    }
  }
  async run(
    command: string,
    args: string[],
    extra: Record<string, string> = {},
    timeoutMs = 30000,
  ): Promise<CommandResult> {
    const out = join(this.root, `out-${crypto.randomUUID()}`),
      err = join(this.root, `err-${crypto.randomUUID()}`);
    try {
      const result = await runCommand(
        "/bin/sh",
        [
          "-c",
          'ulimit -f 256; exec "$@" >"$PROBE_OUT" 2>"$PROBE_ERR"',
          "probe",
          this.command,
          ...this.prefix,
          command,
          ...args,
        ],
        {
          cwd: this.home,
          env: {
            ...commandEnvironment(this.home, this.codeRoot, { isolated: true }),
            PATH: `${join(this.root, "tools")}:${commandEnvironment(this.home, this.codeRoot, { isolated: true }).PATH}`,
            TMPDIR: join(this.root, "tmp"),
            FM_LINEAR_PROBE_TASK: basename(this.scratch).slice(3),
            ...extra,
            PROBE_OUT: out,
            PROBE_ERR: err,
          },
          timeoutMs,
          limit: 128 * 1024,
        },
      );
      return {
        code: result.code,
        stdout: await readFile(out, "utf8").catch(() => ""),
        stderr: await readFile(err, "utf8").catch(() => ""),
      };
    } finally {
      await rm(out, { force: true });
      await rm(err, { force: true });
    }
  }
  private async verifyIsolation() {
    const sentinel = await mkdtemp(join(tmpdir(), "fm-linear-denied-"));
    const file = join(sentinel, "private");
    await writeFile(file, "PRIVATE_ISOLATION_CANARY");
    try {
      const result = await this.run("/bin/sh", [
        "-c",
        'if cat "$1" >/dev/null 2>&1; then exit 31; fi; if /usr/bin/touch "$1" >/dev/null 2>&1; then exit 32; fi; echo ok',
        "probe",
        file,
      ]);
      if (result.code !== 0 || result.stdout.trim() !== "ok")
        throw new FmError(
          "firstmate.contract_failed",
          "Filesystem isolation could not be verified.",
        );
      // Bind denial proves probes cannot establish an outbound connection or a local listener.
      const node = Bun.which("node");
      if (!node)
        throw new FmError(
          "firstmate.contract_failed",
          "Node is required for the isolated Firstmate extension contract.",
        );
      const network = await this.run(node, [
        "-e",
        "const n=require('net');const s=n.createServer();s.on('error',()=>process.exit(0));s.listen(0,'127.0.0.1',()=>{s.close();process.exit(33)});setTimeout(()=>process.exit(34),2000)",
      ]);
      // A network namespace may allow loopback listeners while isolating the host; verify that separately on Linux.
      if (process.platform === "darwin" && network.code !== 0)
        throw new FmError("firstmate.contract_failed", "Network isolation could not be verified.");
      if (process.platform === "linux") {
        const check = await this.run("/bin/sh", [
          "-c",
          'test "$(readlink /proc/self/ns/net)" != "$1"',
          "probe",
          await readlink("/proc/self/ns/net"),
        ]);
        if (check.code !== 0)
          throw new FmError(
            "firstmate.contract_failed",
            "Network namespace isolation could not be verified.",
          );
      }
    } finally {
      await rm(sentinel, { recursive: true, force: true });
    }
  }
  async close() {
    // Upstream deliberately makes installed package directories read-only.
    const writable = async (path: string): Promise<void> => {
      await chmod(path, 0o700);
      for (const entry of await readdir(path, { withFileTypes: true }))
        if (entry.isDirectory()) await writable(join(path, entry.name));
    };
    await writable(this.root);
    await rm(this.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await rm(this.scratch, { recursive: true, force: true });
  }
}
