import { z } from "zod";
import { FmError } from "../support/errors";
import { AttemptId, TaskId } from "./types";

// Accept additive upstream fields, but never default missing evidence to completeness.
export const RegistryRoute = z.object({
  id: TaskId,
  home: z.string().nullable(),
  host: z.string().nullable(),
  root: z.string().nullable(),
  remote: z.boolean(),
  registered: z.boolean(),
  registry_error: z.string().nullable(),
});
export const FleetDocument = z.object({
  schema: z.literal("fm-fleet-snapshot.v1"),
  generated: z.string(),
  fm_home: z.string(),
  roots: z.object({ fm_root: z.string() }),
  tasks: z
    .array(
      z.object({
        id: TaskId,
        kind: z.string(),
        spawn_gen: AttemptId.nullable(),
        current_state: z.object({
          state: z.string(),
          source: z.string(),
          observed_at: z.string(),
          detail: z.string().nullable().optional(),
        }),
      }),
    )
    .max(10000),
  backlog: z.object({
    present: z.boolean(),
    records: z
      .array(
        z.object({
          structured: z.boolean(),
          id: TaskId.nullable(),
          state: z.string().nullable(),
          kind: z.string().nullable().optional(),
          blocked_by_ids: z.array(TaskId).optional(),
        }),
      )
      .max(10000),
  }),
  secondmate_current: z.object({
    registry: z.object({
      available: z.boolean(),
      complete: z.boolean(),
      records: z.array(RegistryRoute).max(1000),
    }),
    records: z
      .array(
        z.object({
          id: TaskId,
          freshness: z.object({ observed_at: z.string().nullable(), status: z.string() }),
          provenance: z.union([z.string(), z.object({ summary_source: z.string().optional() })]),
          omitted: z
            .array(z.object({ surface: z.string(), count: z.number().int().nonnegative() }))
            .optional(),
        }),
      )
      .max(1000),
    truncated: z.number().int().nonnegative(),
  }),
});
export type FleetDocument = z.infer<typeof FleetDocument>;
export type RegistryRoute = z.infer<typeof RegistryRoute>;

export function parseFleet(text: string): FleetDocument {
  try {
    const doc = FleetDocument.parse(JSON.parse(text));
    for (const ids of [
      doc.tasks.map((t) => t.id),
      doc.secondmate_current.registry.records.map((r) => r.id),
    ])
      if (new Set(ids).size !== ids.length) throw new Error("duplicate identities");
    const backlogIds = doc.backlog.records.filter((r) => r.structured && r.id).map((r) => r.id);
    if (new Set(backlogIds).size !== backlogIds.length)
      throw new Error("duplicate backlog identities");
    return doc;
  } catch {
    throw new FmError(
      "firstmate.contract_failed",
      "Firstmate returned an unsupported or ambiguous fleet snapshot.",
    );
  }
}
