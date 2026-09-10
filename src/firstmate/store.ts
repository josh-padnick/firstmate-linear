import { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { FmError } from "../support/errors";

/** Private operational records. Logs never carry these payloads. */
export class AdapterStore {
  readonly db: Database;
  constructor(
    readonly path: string,
    options: { existing?: boolean } = {},
  ) {
    const dir = dirname(resolve(path));
    if (!options.existing) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if ((lstatSync(dir).mode & 0o077) !== 0)
      throw new FmError("storage.unavailable", "The state directory must be private (mode 700).");
    if (realpathSync(dir) !== dir || lstatSync(dir).isSymbolicLink())
      throw new FmError("storage.unavailable", "A linked state directory was refused.");
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new FmError("storage.unavailable", "An unsafe state file was refused.");
    } catch (error) {
      if (options.existing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.db = new Database(path, { create: !options.existing, strict: true });
    chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    const version = this.db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()?.user_version;
    if (version !== 0 && version !== 1 && version !== 2) {
      this.db.close();
      throw new FmError("storage.unavailable", "The state schema is newer than this adapter.");
    }
    this.db.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS records (
        home TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
        PRIMARY KEY(home,kind,id));
        CREATE TABLE IF NOT EXISTS requests (
        home TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), receipt TEXT NOT NULL CHECK(json_valid(receipt)),
        PRIMARY KEY(home,id));
        CREATE TABLE IF NOT EXISTS polls (
        home TEXT NOT NULL, host_request TEXT NOT NULL, request_id TEXT NOT NULL,
        PRIMARY KEY(home,host_request), UNIQUE(home,request_id),
        FOREIGN KEY(home,request_id) REFERENCES requests(home,id));
        CREATE TABLE IF NOT EXISTS fleet_routes (
          primary_home TEXT NOT NULL, secondmate TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
          PRIMARY KEY(primary_home,secondmate));
        CREATE TABLE IF NOT EXISTS fleet_observations (
          primary_home TEXT NOT NULL, home TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
          PRIMARY KEY(primary_home,home));
        CREATE TABLE IF NOT EXISTS fleet_locks (
          primary_home TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL);
        PRAGMA user_version=2;`);
    })();
  }
  get<T>(home: string, kind: string, id: string): T | null {
    const r = this.db
      .query<{ value: string }, [string, string, string]>(
        "SELECT value FROM records WHERE home=? AND kind=? AND id=?",
      )
      .get(home, kind, id);
    return r ? (JSON.parse(r.value) as T) : null;
  }
  put(home: string, kind: string, id: string, value: unknown) {
    this.db
      .query(
        "INSERT INTO records(home,kind,id,value) VALUES(?,?,?,?) ON CONFLICT(home,kind,id) DO UPDATE SET value=excluded.value",
      )
      .run(home, kind, id, JSON.stringify(value));
  }
  once<T>(home: string, kind: string, id: string, value: T): T {
    return this.db.transaction(() => {
      const prior = this.get<T>(home, kind, id);
      if (prior !== null) return prior;
      this.put(home, kind, id, value);
      return value;
    })();
  }
  close() {
    this.db.close();
  }
}
