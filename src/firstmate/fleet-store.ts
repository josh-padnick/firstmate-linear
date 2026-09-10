import { randomUUID } from "node:crypto";
import { FmError } from "../support/errors";
import type { FirstmateHomeObservation, FirstmateHomeRoute } from "./fleet-types";
import type { AdapterStore } from "./store";
import { HomeId } from "./types";

/** Adapter-owned records; accepted observations and coverage are one transaction. */
export class FleetStore {
  constructor(
    private store: AdapterStore,
    private primary: string,
  ) {}
  routes(): FirstmateHomeRoute[] {
    return this.store.db
      .query<{ value: string }, [string]>("SELECT value FROM fleet_routes WHERE primary_home=?")
      .all(this.primary)
      .map((r) => JSON.parse(r.value));
  }
  bind(route: FirstmateHomeRoute): FirstmateHomeRoute {
    return this.store.db.transaction(() => {
      if (
        this.routes().some(
          (r) => r.owner.secondmateId !== route.owner.secondmateId && sameRoute(r, route),
        )
      )
        throw new FmError(
          "firstmate.contract_failed",
          "Two registered secondmate IDs select the same home; the route is ambiguous.",
        );
      const prior = this.routes().find((r) => r.owner.secondmateId === route.owner.secondmateId);
      if (prior) {
        if (!sameRoute(prior, route))
          throw new FmError(
            "firstmate.route_changed",
            "This secondmate's registered route changed. Its previous work remains associated with the original home.",
          );
        return prior;
      }
      const bound = {
        ...route,
        owner: { ...route.owner, homeId: HomeId.parse(`home-${randomUUID()}`) },
      };
      this.store.db
        .query("INSERT INTO fleet_routes(primary_home,secondmate,value) VALUES(?,?,?)")
        .run(this.primary, route.owner.secondmateId, JSON.stringify(bound));
      return bound;
    })();
  }
  observations(): FirstmateHomeObservation[] {
    return this.store.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM fleet_observations WHERE primary_home=?",
      )
      .all(this.primary)
      .map((r) => JSON.parse(r.value));
  }
  acquire(now: number): string {
    const token = randomUUID();
    const changed = this.store.db
      .query(
        "INSERT INTO fleet_locks(primary_home,token,expires) VALUES(?,?,?) ON CONFLICT(primary_home) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE fleet_locks.expires<=?",
      )
      .run(this.primary, token, now + 120000, now);
    if (!changed.changes)
      throw new FmError(
        "firstmate.scan_busy",
        "Another fleet read is already running for this primary home.",
      );
    return token;
  }
  save(
    homes: FirstmateHomeObservation[],
    token: string,
    now: number,
    registryRevision: string | null,
  ) {
    this.store.db.transaction(() => {
      const lock = this.store.db
        .query<{ token: string; expires: number }, [string]>(
          "SELECT token,expires FROM fleet_locks WHERE primary_home=?",
        )
        .get(this.primary);
      if (lock?.token !== token || lock.expires <= now)
        throw new FmError(
          "firstmate.scan_busy",
          "This fleet read no longer owns its observation lease.",
        );
      const metrics = this.store.get<{ scanCount: number }>(this.primary, "fleet", "metrics");
      this.store.put(this.primary, "fleet", "metrics", {
        scanCount: (metrics?.scanCount ?? 0) + 1,
        lastCollectedAt: new Date(now).toISOString(),
        staleHomes: homes.filter((h) => h.freshness !== "fresh").length,
        partialHomes: homes.filter((h) => h.coverage !== "complete").length,
        sourceAgesSeconds: homes.map((h) => ({ homeId: h.owner.homeId, ageSeconds: h.ageSeconds })),
        agentMessages: 0,
      });
      this.store.put(this.primary, "fleet", "registry-revision", { revision: registryRevision });
      for (const home of homes)
        this.store.db
          .query(
            "INSERT INTO fleet_observations(primary_home,home,value) VALUES(?,?,?) ON CONFLICT(primary_home,home) DO UPDATE SET value=excluded.value",
          )
          .run(this.primary, home.owner.homeId, JSON.stringify(home));
    })();
  }
  release(token: string) {
    this.store.db
      .query("DELETE FROM fleet_locks WHERE primary_home=? AND token=?")
      .run(this.primary, token);
  }
}
export function sameRoute(a: FirstmateHomeRoute, b: FirstmateHomeRoute) {
  return a.kind === b.kind && a.home === b.home && a.codeRoot === b.codeRoot && a.host === b.host;
}
