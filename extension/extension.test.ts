import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { install } from "../src/install/install.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function invoke(operation: string, input: Record<string, unknown>): Promise<any> {
  const process = Bun.spawn(["node", join(import.meta.dir, "bin", "fm-linear-extension"), "invoke"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  process.stdin.write(JSON.stringify({
    schema: "firstmate.extension-request.v1",
    request_id: `sha256:${"a".repeat(64)}`,
    operation,
    input,
  }));
  process.stdin.end();
  const response = await new Response(process.stdout).json();
  expect(await process.exited).toBe(0);
  return response;
}

describe("Firstmate extension adapter", () => {
  test("the installed extension executes as an ES module", async () => {
    const root = mkdtempSync("/private/tmp/fml-extension-install-");
    roots.push(root);
    const home = join(root, "home");
    const firstmate = join(root, "firstmate");
    mkdirSync(join(firstmate, "bin"), { recursive: true });
    for (const command of ["fm-extension.sh", "fm-procevent.sh"]) {
      const path = join(firstmate, "bin", command);
      writeFileSync(path, "#!/bin/sh\nexit 0\n");
      chmodSync(path, 0o755);
    }
    const runtime = join(root, "runtime");
    install({ harnesses: [], bind: true, env: {
      FM_HOME: home,
      FM_ROOT_OVERRIDE: firstmate,
      FM_LINEAR_INSTALL_ROOT: runtime,
      FM_LINEAR_LAUNCH_AGENTS_DIR: join(root, "agents"),
      FM_LINEAR_SKIP_LAUNCHCTL: "1",
      FM_LINEAR_REAL_LINEAR_AXI: "/usr/bin/true",
    } });
    const process = Bun.spawn(["node", "--no-experimental-detect-module", join(runtime, "extension", "1.0.0", "bin", "fm-linear-extension"), "handshake"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    process.stdin.write(JSON.stringify({
      schema: "firstmate.extension-handshake-request.v1",
      request_id: `sha256:${"a".repeat(64)}`,
      extension_id: "dev.firstmate.linear",
      extension_version: "1.0.0",
    }));
    process.stdin.end();

    expect(await process.exited).toBe(0);
    expect(await new Response(process.stdout).json()).toMatchObject({ schema: "firstmate.extension-handshake-response.v1", extension_id: "dev.firstmate.linear" });
  });

  test("carries the source socket into captured content for later result operations", async () => {
    const root = mkdtempSync("/private/tmp/fml-extension-");
    roots.push(root);
    const socketPath = join(root, "service.sock");
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((socket) => {
      let body = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        body += chunk;
        const newline = body.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(body) as Record<string, unknown>;
        requests.push(request);
        const result = request.op === "source.poll"
          ? { status: "result", output: JSON.stringify({ schema: "fm-linear.core-event.v1", event_id: "event:one" }) }
          : { classification: "comment" };
        socket.end(JSON.stringify({ ok: true, result }));
      });
    });
    server.listen(socketPath);
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });

    try {
      const polled = await invoke("source.poll", { source_id: "linear-main", config_ref: socketPath });
      expect(polled.ok).toBe(true);
      const content = JSON.parse(polled.result.output) as { event_id: string; service_socket: string };
      expect(content).toEqual(expect.objectContaining({ event_id: "event:one", service_socket: socketPath }));

      const classified = await invoke("result.classify", {
        source_id: "linear-main",
        sequence: 7,
        content: polled.result.output,
      });
      expect(classified).toMatchObject({ ok: true, result: { classification: "comment" } });
      expect(requests).toEqual([
        { op: "source.poll", request_id: `sha256:${"a".repeat(64)}`, sequence: 0 },
        { op: "result.classify", event_id: "event:one", sequence: 7 },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
