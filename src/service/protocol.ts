import type { StateDatabase } from "../db/database.ts";

export type ServiceRequest =
  | { op: "source.poll"; request_id: string; sequence?: number }
  | { op: "result.classify"; event_id: string; sequence: number }
  | { op: "result.silent"; event_id: string; sequence: number }
  | { op: "result.terminal"; event_id: string; sequence: number };

export type ServiceResponse =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string; retryable: boolean };

export function eventOutput(event: { id: string; issue: string; token: string; author: string; raw_ref: string }): string {
  let raw: unknown = null;
  try { raw = JSON.parse(event.raw_ref); } catch { raw = null; }
  return JSON.stringify({
    schema: "fm-linear.core-event.v1",
    event_id: event.id,
    issue: event.issue,
    token: event.token,
    author: event.author,
    event: raw,
    required: `Run fm-linear inbox show ${event.id}`,
    then: `Handle with fm-linear act or fm-linear inbox handle ${event.id}`,
  });
}

export function handleServiceRequest(db: StateDatabase, request: ServiceRequest): ServiceResponse {
  try {
    switch (request.op) {
      case "source.poll": {
        const event = db.nextForCore(request.request_id, request.sequence ?? 0);
        return event
          ? { ok: true, result: { status: "result", output: eventOutput(event) } }
          : { ok: true, result: { status: "no-result", output: "" } };
      }
      case "result.classify": {
        const event = db.event(request.event_id);
        if (!event) return { ok: false, error: "event not found", retryable: false };
        db.bindDeliverySequence(event.id, request.sequence);
        return { ok: true, result: { classification: event.token } };
      }
      case "result.silent": {
        const event = db.event(request.event_id);
        if (!event) return { ok: false, error: "event not found", retryable: false };
        db.bindDeliverySequence(event.id, request.sequence);
        const silent = event.disposition === "ignored" || event.disposition === "handled-by-service";
        if (silent) db.markDeliveryHandled(event.id);
        return { ok: true, result: { value: silent } };
      }
      case "result.terminal":
        return { ok: true, result: { value: false } };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), retryable: true };
  }
}

export async function handleLongPollRequest(
  db: StateDatabase,
  request: ServiceRequest,
  waitMs = Number(process.env.FM_LINEAR_SOURCE_POLL_MS ?? 55_000),
  active: () => boolean = () => true,
): Promise<ServiceResponse> {
  if (request.op !== "source.poll") return handleServiceRequest(db, request);
  if (!active()) return { ok: true, result: { status: "no-result", output: "" } };
  const boundedWait = Number.isFinite(waitMs) ? Math.max(0, Math.min(55_000, Math.floor(waitMs))) : 55_000;
  const deadline = Date.now() + boundedWait;
  while (true) {
    if (!active()) return { ok: true, result: { status: "no-result", output: "" } };
    const response = handleServiceRequest(db, request);
    if (!response.ok || response.result.status === "result" || Date.now() >= deadline) return response;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
  }
}
