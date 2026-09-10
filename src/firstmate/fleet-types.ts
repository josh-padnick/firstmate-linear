import type { z } from "zod";
import type { FirstmateTaskRef, FirstmateTaskSnapshot, HomeId } from "./types";

export interface FirstmateHomeRef {
  homeId: z.infer<typeof HomeId>;
  primaryHomeId: z.infer<typeof HomeId>;
  secondmateId: string | null;
}
export interface FirstmateHomeRoute {
  owner: FirstmateHomeRef;
  kind: "primary" | "local" | "remote";
  home: string;
  codeRoot: string;
  host: string | null;
}
export interface FirstmateWorkObservation {
  task: FirstmateTaskRef;
  kind: "worker" | "secondmate" | "backlog";
  attempt: FirstmateTaskSnapshot["attempt"];
  activity: FirstmateTaskSnapshot["activity"];
  backlogState: string | null;
  dependencies: FirstmateTaskRef[] | null;
  observedAt: string;
  visibility: "current" | "last-known";
}
export interface FirstmateHomeObservation {
  owner: FirstmateHomeRef;
  route: FirstmateHomeRoute;
  coverage: "complete" | "partial" | "unavailable" | "held";
  reasons: string[];
  observedAt: string | null;
  collectedAt: string;
  ageSeconds: number | null;
  freshness: "fresh" | "stale" | "unknown";
  provenance: "full-local-snapshot" | "full-routed-snapshot" | "saved-observation";
  summary: { observedAt: string | null; source: string; omitted: number } | null;
  work: FirstmateWorkObservation[];
  consecutiveFailures: number;
  retryAfter: string | null;
}
export interface FirstmateFleetSnapshot {
  schemaVersion: 1;
  primaryHomeId: z.infer<typeof HomeId>;
  collectedAt: string;
  coverage: "complete" | "partial";
  homes: FirstmateHomeObservation[];
  metrics: { durationMs: number; sourceReads: number; staleHomes: number; agentMessages: 0 };
}
export interface FleetReadOptions {
  /** Direct children only. Omit to discover all visible registered children. */
  secondmateIds?: string[];
  staleAfterSeconds?: number;
  /** Explicit inspections bypass scan backoff. */
  refresh?: boolean;
}
