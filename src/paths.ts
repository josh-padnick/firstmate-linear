// New-runtime state layout. These names must never collide with the live
// bash files (.linear-cursor, .linear-seen.tsv, linear-inbox/, linear-outbox/).

import { resolveHome, resolveStateDir } from "./env.ts";
import { sha256 } from "./hash.ts";
import { tmpdir } from "node:os";

export type RuntimePaths = {
  home: string;
  state: string;
  root: string;
  serviceLog: string;
  database: string;
  databaseBackups: string;
  socket: string;
  serviceLock: string;
  serviceHealth: string;
  deadLetters: string;
  artifacts: string;
};

export function runtimePaths(env: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const home = resolveHome(env);
  const state = resolveStateDir(home, env);
  const root = `${state}/linear`;
  const preferredSocket = `${root}/service.sock`;
  const socket = Buffer.byteLength(preferredSocket) <= 100
    ? preferredSocket
    : `${tmpdir()}/fm-linear-${process.getuid?.() ?? 0}-${sha256(home).slice(0, 12)}/service.sock`;
  return {
    home,
    state,
    root,
    serviceLog: `${root}/service.log`,
    database: `${root}/fm-linear.db`,
    databaseBackups: `${root}/backups`,
    socket,
    serviceLock: `${root}/service.lock`,
    serviceHealth: `${root}/health.json`,
    deadLetters: `${root}/dead-letters`,
    artifacts: `${root}/artifacts`,
  };
}

export const LIVE_STATE_FORBIDDEN = [
  ".linear-cursor",
  ".linear-seen.tsv",
  ".linear-poll-health",
  ".linear-poll-error",
  ".linear-poll-loop.pid",
  ".linear-poll-loop.log",
  ".linear-poll-lock",
  ".linear-act-lock",
  "linear-inbox",
  "linear-outbox",
] as const;
