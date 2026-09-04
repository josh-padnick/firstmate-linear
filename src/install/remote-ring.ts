import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { resolveHome } from "../env.ts";
import { StateDatabase } from "../db/database.ts";
import { nowIso } from "../time.ts";
import { loadConfig } from "../config/load.ts";

export function renderRemoteRingCheck(maxAgeSeconds: number): string {
  return `#!/bin/sh
set -eu
state="\${FM_HOME:?}/state"
now=$(date +%s)
find "$state" -maxdepth 2 -type f -path '*.inbox/[0-9]*.msg' -print 2>/dev/null | while IFS= read -r record; do
  modified=$(stat -f %m "$record" 2>/dev/null || stat -c %Y "$record" 2>/dev/null || echo "$now")
  if [ $((now - modified)) -ge ${maxAgeSeconds} ]; then
    echo "fm-linear: unhandled inbox record older than ${maxAgeSeconds}s"
    break
  fi
done
`;
}

export function installRemoteRing(remoteHome: string, env: NodeJS.ProcessEnv = process.env): void {
  const home = resolveHome(env);
  const firstmateRoot = env.FM_ROOT_OVERRIDE?.trim() || home;
  const fmOn = join(firstmateRoot, "bin", "fm-on.sh");
  const remotePath = "state/fm-linear-inbox-ring.check.sh";
  const script = Buffer.from(renderRemoteRingCheck(loadConfig(env).deadlines.steer.redeliver), "utf8").toString("base64");
  const command = `umask 077; python3 -c "import base64,pathlib;pathlib.Path('${remotePath}').write_bytes(base64.b64decode('${script}'))"; chmod 700 '${remotePath}'`;
  const common = { encoding: "utf8" as const, env: { ...process.env, ...env, FM_HOME: home }, timeout: 30_000 };
  const write = spawnSync(fmOn, [remoteHome, "sh", "-c", command], common);
  const db = StateDatabase.open(env);
  try {
    if (write.status !== 0) {
      const error = (write.stderr || write.stdout || "remote write failed").trim();
      db.raw.query(`INSERT INTO remote_rings(home,last_error,checked_at) VALUES(?,?,?)
        ON CONFLICT(home) DO UPDATE SET last_error=excluded.last_error,checked_at=excluded.checked_at`).run(remoteHome, error, nowIso(env));
      throw new Error(error);
    }
    const register = spawnSync(fmOn, [remoteHome, "fm-check-register.sh", remotePath], common);
    if (register.status !== 0) throw new Error((register.stderr || register.stdout || "remote check registration failed").trim());
    db.raw.query(`INSERT INTO remote_rings(home,installed_at,last_error,checked_at) VALUES(?,?,NULL,?)
      ON CONFLICT(home) DO UPDATE SET installed_at=excluded.installed_at,last_error=NULL,checked_at=excluded.checked_at`).run(remoteHome, nowIso(env), nowIso(env));
  } catch (error) {
    db.raw.query(`INSERT INTO remote_rings(home,last_error,checked_at) VALUES(?,?,?)
      ON CONFLICT(home) DO UPDATE SET last_error=excluded.last_error,checked_at=excluded.checked_at`).run(remoteHome, error instanceof Error ? error.message : String(error), nowIso(env));
    throw error;
  } finally { db.close(); }
}
