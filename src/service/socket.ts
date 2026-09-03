import { createConnection, createServer, type Server, type Socket } from "node:net";
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { StateDatabase } from "../db/database.ts";
import { ensurePrivateDir } from "../fsutil.ts";
import { handleLongPollRequest, type ServiceRequest, type ServiceResponse } from "./protocol.ts";

const MAX_MESSAGE = 65_536;

function write(socket: Socket, response: ServiceResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

export function createSocketServer(path: string, db: StateDatabase, active: () => boolean = () => true): Server {
  ensurePrivateDir(dirname(path));
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isSocket()) throw new Error(`refusing to replace non-socket path: ${path}`);
    unlinkSync(path);
  }
  const server = createServer((socket) => {
    let body = "";
    let accepted = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_MESSAGE) {
        write(socket, { ok: false, error: "request too large", retryable: false });
        socket.destroy();
      }
      const newline = body.indexOf("\n");
      if (newline >= 0 && !accepted) {
        accepted = true;
        const one = body.slice(0, newline);
        body = "";
        try {
          void handleLongPollRequest(db, JSON.parse(one) as ServiceRequest, undefined, active)
            .then((response) => write(socket, response))
            .catch(() => write(socket, { ok: false, error: "service failure", retryable: true }));
        } catch {
          write(socket, { ok: false, error: "invalid request", retryable: false });
        }
      }
    });
  });
  server.listen(path);
  return server;
}

export async function socketRequest(path: string, request: ServiceRequest, timeoutMs = 10_000): Promise<ServiceResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    let body = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("service socket timeout"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_MESSAGE) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error("service response too large"));
      }
    });
    socket.on("end", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(body.trim()) as ServiceResponse); }
      catch { reject(new Error("invalid service response")); }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
