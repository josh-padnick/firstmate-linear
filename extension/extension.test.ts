import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

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
