import { isAbsolute } from "node:path";
import { FmError } from "../support/errors";
import { FleetReader } from "./fleet-reader";
import type { FleetDocument, RegistryRoute } from "./fleet-schema";
import { FleetStore } from "./fleet-store";
import type {
  FirstmateFleetSnapshot,
  FirstmateHomeObservation,
  FirstmateHomeRoute,
  FirstmateWorkObservation,
  FleetReadOptions,
} from "./fleet-types";
import type { AdapterStore } from "./store";
import { type FirstmateInstallation, TaskId } from "./types";

export function freshness(
  observedAt: string | null,
  now: number,
  staleAfter = 360,
): Pick<FirstmateHomeObservation, "ageSeconds" | "freshness"> {
  const time = observedAt === null ? NaN : Date.parse(observedAt);
  if (!Number.isFinite(time) || time > now) return { ageSeconds: null, freshness: "unknown" };
  const ageSeconds = (now - time) / 1000;
  return { ageSeconds, freshness: ageSeconds <= staleAfter ? "fresh" : "stale" };
}
export function primaryRoute(installation: FirstmateInstallation): FirstmateHomeRoute {
  return {
    owner: { homeId: installation.homeId, primaryHomeId: installation.homeId, secondmateId: null },
    kind: "primary",
    home: installation.home,
    codeRoot: installation.codeRoot,
    host: null,
  };
}
export function childRoute(
  installation: FirstmateInstallation,
  row: RegistryRoute,
): FirstmateHomeRoute {
  const codeRoot = row.remote ? row.root : installation.codeRoot;
  if (
    !row.registered ||
    row.registry_error ||
    !row.home ||
    !codeRoot ||
    !isAbsolute(row.home) ||
    !isAbsolute(codeRoot) ||
    /[\r\n\t]/.test(row.home + codeRoot) ||
    (row.remote && !row.host)
  )
    throw new FmError(
      "firstmate.contract_failed",
      "The secondmate registry contains an invalid route.",
    );
  return {
    owner: {
      homeId: installation.homeId,
      primaryHomeId: installation.homeId,
      secondmateId: row.id,
    },
    kind: row.remote ? "remote" : "local",
    home: row.home,
    codeRoot,
    host: row.host,
  };
}
export function normalizeHome(
  doc: FleetDocument,
  route: FirstmateHomeRoute,
  collectedAt: string,
  prior?: FirstmateHomeObservation,
  staleAfter = 360,
): FirstmateHomeObservation {
  const age = freshness(doc.generated, Date.parse(collectedAt), staleAfter);
  const reasons: string[] = [];
  if (doc.backlog.records.some((r) => !r.structured || !r.id)) reasons.push("unstructured-backlog");
  if (age.freshness !== "fresh") reasons.push("source-time-unverified-or-stale");
  const work = new Map<string, FirstmateWorkObservation>();
  for (const row of doc.backlog.records) {
    if (!row.structured || !row.id) continue;
    work.set(row.id, {
      task: { homeId: route.owner.homeId, taskId: row.id },
      kind: "backlog",
      attempt: null,
      activity: { state: "unknown", source: "backlog" },
      backlogState: row.state,
      dependencies:
        row.blocked_by_ids?.map((taskId) => ({ homeId: route.owner.homeId, taskId })) ?? null,
      observedAt: doc.generated,
      visibility: age.freshness === "fresh" ? "current" : "last-known",
    });
  }
  for (const row of doc.tasks) {
    const task = { homeId: route.owner.homeId, taskId: row.id };
    const backlog = work.get(row.id);
    work.set(row.id, {
      task,
      kind: row.kind === "secondmate" ? "secondmate" : "worker",
      attempt:
        row.spawn_gen && row.current_state.detail !== "task generation changed during snapshot"
          ? { task, attemptId: row.spawn_gen }
          : null,
      activity: { state: row.current_state.state, source: row.current_state.source },
      backlogState: backlog?.backlogState ?? null,
      dependencies: backlog?.dependencies ?? null,
      observedAt: row.current_state.observed_at,
      visibility:
        freshness(row.current_state.observed_at, Date.parse(collectedAt), staleAfter).freshness ===
        "fresh"
          ? "current"
          : "last-known",
    });
  }
  for (const old of prior?.work ?? []) {
    const next = work.get(old.task.taskId);
    const oldTimeTrusted =
      prior?.freshness !== "unknown" &&
      Number.isFinite(Date.parse(old.observedAt)) &&
      Date.parse(old.observedAt) <= Date.parse(prior?.collectedAt ?? "");
    // A missing or older record cannot erase work or roll back a newer attempt.
    if (
      !next ||
      !Number.isFinite(Date.parse(next.observedAt)) ||
      Date.parse(next.observedAt) > Date.parse(collectedAt) ||
      (oldTimeTrusted &&
        ((next.observedAt === old.observedAt &&
          next.attempt?.attemptId !== old.attempt?.attemptId) ||
          Date.parse(next.observedAt) < Date.parse(old.observedAt)))
    ) {
      work.set(old.task.taskId, { ...old, visibility: "last-known" });
      if (next) reasons.push("out-of-order-evidence");
    }
  }
  return {
    owner: route.owner,
    route,
    coverage: reasons.length ? "partial" : "complete",
    reasons: [...new Set(reasons)],
    observedAt: doc.generated,
    collectedAt,
    ...age,
    provenance: route.kind === "remote" ? "full-routed-snapshot" : "full-local-snapshot",
    summary: null,
    work: [...work.values()],
    consecutiveFailures: 0,
    retryAfter: null,
  };
}

export async function getFirstmateFleet(
  installation: FirstmateInstallation,
  store: AdapterStore,
  options: FleetReadOptions = {},
  reader = new FleetReader(installation),
): Promise<FirstmateFleetSnapshot> {
  const start = Date.now();
  const selected = options.secondmateIds?.map((id) => TaskId.parse(id));
  const staleAfter = options.staleAfterSeconds ?? 360;
  if (!Number.isFinite(staleAfter) || staleAfter < 1)
    throw new FmError(
      "config.invalid",
      "The stale threshold must be a positive number of seconds.",
    );
  const persistence = new FleetStore(store, installation.homeId);
  const lease = persistence.acquire(start);
  const prior = persistence.observations();
  const homes: FirstmateHomeObservation[] = [];
  let registryComplete = false;
  const failed = (
    route: FirstmateHomeRoute,
    reason: string,
    held = false,
  ): FirstmateHomeObservation => {
    const old = prior.find((h) => h.owner.homeId === route.owner.homeId);
    const collectedAt = new Date().toISOString();
    const failures = (old?.consecutiveFailures ?? 0) + (reason === "read-backoff" ? 0 : 1);
    return {
      owner: route.owner,
      route,
      coverage: held ? "held" : "unavailable",
      reasons: [reason],
      observedAt: old?.observedAt ?? null,
      collectedAt,
      ...freshness(old?.observedAt ?? null, Date.now(), staleAfter),
      provenance: "saved-observation",
      summary: old?.summary ?? null,
      work: old?.work.map((w) => ({ ...w, visibility: "last-known" })) ?? [],
      consecutiveFailures: failures,
      retryAfter:
        reason === "read-backoff"
          ? (old?.retryAfter ?? null)
          : new Date(
              Date.now() + Math.min(300000, 30000 * 2 ** Math.min(failures - 1, 4)),
            ).toISOString(),
    };
  };
  try {
    const revision = await reader.registryRevision();
    const primary = primaryRoute(installation);
    let doc: FleetDocument | undefined;
    try {
      const old = prior.find((h) => h.owner.homeId === primary.owner.homeId);
      if (!options.refresh && old?.retryAfter && Date.parse(old.retryAfter) > Date.now())
        throw new FmError("firstmate.read_backoff", "The primary read is waiting before retrying.");
      doc = await reader.snapshot(primary);
      homes.push(
        normalizeHome(
          doc,
          primary,
          new Date().toISOString(),
          prior.find((h) => h.owner.homeId === primary.owner.homeId),
          staleAfter,
        ),
      );
      registryComplete =
        doc.secondmate_current.registry.complete && doc.secondmate_current.registry.available;
    } catch (error) {
      if (!(error instanceof FmError)) throw error;
      homes.push(
        failed(primary, error.code === "firstmate.read_backoff" ? "read-backoff" : error.code),
      );
    }
    const registered = doc?.secondmate_current.registry.records ?? [];
    const rows = registered.filter((r) => !selected || selected.includes(r.id));
    if (rows.length > 20 || selected?.some((id) => !rows.some((r) => r.id === id))) {
      registryComplete = false;
      homes[0]?.reasons.push(rows.length > 20 ? "home-read-limit" : "selected-home-not-found");
    }
    let cursor = 0;
    // Two home reads at a time, one overall 60-second budget, no agent wakeups.
    const results = await Promise.allSettled(
      [0, 1].map(async () => {
        while (cursor < Math.min(rows.length, 20)) {
          const row = rows[cursor++];
          if (!row) continue;
          let route = persistence.routes().find((r) => r.owner.secondmateId === row.id);
          try {
            route = persistence.bind(childRoute(installation, row));
            const old = prior.find((h) => h.owner.homeId === route?.owner.homeId);
            if (!options.refresh && old?.retryAfter && Date.parse(old.retryAfter) > Date.now()) {
              homes.push(failed(route, "read-backoff"));
              continue;
            }
            const child = await reader.snapshot(route);
            const home = normalizeHome(
              child,
              route,
              new Date().toISOString(),
              prior.find((h) => h.owner.homeId === route?.owner.homeId),
              staleAfter,
            );
            if (child.secondmate_current.registry.records.length)
              home.reasons.push("nested-delegation-not-traversed");
            const summary = doc?.secondmate_current.records.find((r) => r.id === row.id);
            if (summary)
              home.summary = {
                observedAt: summary.freshness.observed_at,
                source:
                  typeof summary.provenance === "string"
                    ? summary.provenance
                    : (summary.provenance.summary_source ?? "unknown"),
                omitted: summary.omitted?.reduce((n, o) => n + o.count, 0) ?? 0,
              };
            homes.push(home);
          } catch (error) {
            if (!(error instanceof FmError)) throw error;
            if (route)
              homes.push(
                failed(
                  route,
                  error.code,
                  error.code === "firstmate.route_changed" ||
                    error.code === "firstmate.capability_held",
                ),
              );
            else {
              registryComplete = false;
              homes[0]?.reasons.push(`invalid-route:${row.id}`);
            }
          }
        }
      }),
    );
    const rejected = results.find((r) => r.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
    for (const route of persistence.routes()) {
      if (selected && !selected.includes(TaskId.parse(route.owner.secondmateId))) continue;
      if (!homes.some((h) => h.owner.homeId === route.owner.homeId))
        homes.push(failed(route, "route-not-observed"));
    }
    if (revision !== (await reader.registryRevision())) {
      registryComplete = false;
      for (let i = 1; i < homes.length; i++) {
        const home = homes[i];
        if (home) homes[i] = failed(home.route, "registry-changed-during-read", true);
      }
    }
    homes.sort((a, b) => (a.owner.secondmateId ?? "").localeCompare(b.owner.secondmateId ?? ""));
    persistence.save(homes, lease, Date.now(), registryComplete ? revision : null);
    return {
      schemaVersion: 1,
      primaryHomeId: installation.homeId,
      collectedAt: new Date().toISOString(),
      coverage:
        registryComplete && homes.every((h) => h.coverage === "complete") ? "complete" : "partial",
      homes,
      metrics: {
        durationMs: Date.now() - start,
        sourceReads: reader.reads,
        staleHomes: homes.filter((h) => h.freshness !== "fresh").length,
        agentMessages: 0,
      },
    };
  } finally {
    persistence.release(lease);
  }
}
