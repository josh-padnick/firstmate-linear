import { z } from "zod";
import { hash } from "../support/files";
import { EXTENSION_ADAPTER, EXTENSION_ID, EXTENSION_VERSION, pollRequest } from "./messages";
import { AdapterStore } from "./store";
import { HomeId, MessageToFirstmateSchema, RequestId } from "./types";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identity = {
  request_id: digest,
  extension_id: z.literal(EXTENSION_ID),
  extension_version: z.literal(EXTENSION_VERSION),
  package_digest: digest,
};
const handshake = z
  .object({
    schema: z.literal("firstmate.extension-handshake-request.v1"),
    ...identity,
    host_protocols: z.array(z.number()).refine((v) => v.includes(1)),
    capability: z
      .object({
        name: z.literal("process-event-adapter"),
        versions: z.array(z.number()).refine((v) => v.includes(1)),
        adapter_names: z.tuple([z.literal(EXTENSION_ADAPTER)]),
      })
      .strict(),
  })
  .strict();
const request = z
  .object({
    schema: z.literal("firstmate.extension-request.v1"),
    ...identity,
    host_protocol: z.literal(1),
    capability: z.literal("process-event-adapter"),
    capability_version: z.literal(1),
    adapter: z.literal(EXTENSION_ADAPTER),
    operation: z.enum(["source.poll", "result.classify", "result.terminal", "result.silent"]),
    input: z.unknown(),
  })
  .strict();
const source = z
  .object({ source_id: z.string().regex(/^fml-[a-f0-9]{24}$/), config_ref: z.string().max(4096) })
  .strict();
const resultInput = z
  .object({
    source_id: z.string(),
    sequence: z.union([z.number().int(), z.string()]),
    content: z.string().max(32768),
  })
  .strict();
export function extensionResponse(verb: string, input: unknown): unknown {
  if (verb === "handshake") {
    const r = handshake.parse(input);
    return {
      schema: "firstmate.extension-handshake-response.v1",
      request_id: r.request_id,
      extension_id: EXTENSION_ID,
      extension_version: EXTENSION_VERSION,
      host_protocol: 1,
      capability: "process-event-adapter",
      capability_version: 1,
      adapter_names: [EXTENSION_ADAPTER],
    };
  }
  const r = request.parse(input);
  if (verb !== "invoke") throw new Error("Unsupported operation");
  try {
    let result: unknown;
    if (r.operation === "source.poll") {
      const i = source.parse(r.input);
      if (!i.config_ref.startsWith("fm-linear:")) throw new Error("Invalid source reference");
      const ref = z
        .object({ db: z.string().startsWith("/").max(2000), homeId: HomeId, requestId: RequestId })
        .strict()
        .parse(JSON.parse(Buffer.from(i.config_ref.slice(10), "base64url").toString()));
      if (i.source_id !== `fml-${hash(`${ref.homeId}:${ref.requestId}`).slice(0, 24)}`)
        throw new Error("Wrong source");
      const store = new AdapterStore(ref.db, { existing: true });
      try {
        result = pollRequest(store, ref.homeId, ref.requestId, r.request_id);
      } finally {
        store.close();
      }
    } else {
      const input = resultInput.parse(r.input);
      const packet = JSON.parse(input.content);
      if (packet.schema !== "fm-linear.request.v1") throw new Error("Invalid packet");
      const { schema: _, responseInstructions: __, ...message } = packet;
      const parsed = MessageToFirstmateSchema.parse(message);
      const home =
        parsed.destination.kind === "home"
          ? parsed.destination.homeId
          : parsed.destination.task.homeId;
      if (input.source_id !== `fml-${hash(`${home}:${parsed.requestId}`).slice(0, 24)}`)
        throw new Error("Wrong source");
      result =
        r.operation === "result.classify"
          ? { classification: "fm-linear-request" }
          : { value: r.operation === "result.terminal" };
    }
    return {
      schema: "firstmate.extension-response.v1",
      request_id: r.request_id,
      ok: true,
      result,
      error: null,
    };
  } catch {
    return {
      schema: "firstmate.extension-response.v1",
      request_id: r.request_id,
      ok: false,
      result: null,
      error: {
        code: "invalid-request",
        retryable: false,
        diagnostic: "FM Linear could not validate or retrieve this request.",
      },
    };
  }
}
