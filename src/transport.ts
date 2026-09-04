// Fixture-backed GraphQL transport.
// Preserves FM_LINEAR_FIXTURE_DIR / FM_LINEAR_FIXTURE_LOG from fm_linear_api_call.

import { appendFileSync, copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isExactApproval } from "./classify/classify.ts";
import { classifyFailure, type Classification, type GraphqlError } from "./errors.ts";
import { sha256 } from "./hash.ts";
import { redactedIdentity } from "./identity.ts";

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
export const DEFAULT_HTTP_TIMEOUT_SECONDS = 20;

export type GraphqlPayload = {
  query: string;
  variables?: Record<string, unknown>;
};

export type TransportFailure = {
  operation: string;
  kind: "transport" | "http" | "malformed" | "graphql" | "fixture";
  message: string;
  httpStatus?: number;
  graphqlErrors?: GraphqlError[];
  retryAfterSeconds?: number;
  classification: Classification;
};

export type TransportSuccess = {
  operation: string;
  data: unknown;
  raw: unknown;
};

export type TransportResult =
  | { ok: true; value: TransportSuccess }
  | { ok: false; error: TransportFailure };

export type TransportOptions = {
  apiKey?: string;
  fixtureDir?: string;
  fixtureLog?: string;
  recordDir?: string;
  timeoutSeconds?: number;
  fetchImpl?: typeof fetch;
};

function fail(
  operation: string,
  kind: TransportFailure["kind"],
  message: string,
  extra: Partial<TransportFailure> = {},
): TransportResult {
  const error: TransportFailure = {
    operation,
    kind,
    message,
    ...extra,
    classification: classifyFailure({
      kind,
      message,
      httpStatus: extra.httpStatus,
      graphqlErrors: extra.graphqlErrors,
    }),
  };
  return { ok: false, error };
}

export function redactFixture(value: unknown): unknown {
  const identifiers = new Map<string, string>();
  const visit = (current: unknown, key = "", parents: string[] = []): unknown => {
    if (Array.isArray(current)) return current.map((item) => visit(item, key, parents));
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current).map(([childKey, child]) => [childKey, visit(child, childKey, [...parents, key])]));
    }
    if (typeof current !== "string") return current;
    if (/^body$/i.test(key) && isExactApproval(current)) return "approved";
    if (/^(?:body|description|text|content|title)$/i.test(key)) return "[redacted]";
    if (/email/i.test(key)) return "redacted@example.invalid";
    if (/url/i.test(key)) return "https://example.invalid/redacted";
    if (/^(?:token|secret|apiKey)$/i.test(key)) return "[redacted]";
    const personalContainer = parents.some((parent) => /^(?:viewer|assignee|actor|author|creator|member|members|subscriber|subscribers|user|users)$/i.test(parent));
    if (/^displayName$/i.test(key) || (/^name$/i.test(key) && personalContainer)) return redactedIdentity(current);
    if (key === "identifier" && /^[A-Za-z][A-Za-z0-9]*-[0-9]+$/.test(current)) return current;
    if (/^(?:id|identifier|.*Id)$/i.test(key)) {
      const prior = identifiers.get(current);
      if (prior) return prior;
      const replacement = `redacted-${sha256(current).slice(0, 12)}`;
      identifiers.set(current, replacement);
      return replacement;
    }
    return current;
  };
  return visit(value);
}

function parseJsonObject(text: string): unknown | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

function commentPlaceholder(payload: GraphqlPayload): string {
  const variables = payload.variables ?? {};
  const comment = variables.comment;
  if (typeof comment === "string" && comment) {
    return comment;
  }
  const id = variables.id;
  if (typeof id === "string" && id) {
    return id;
  }
  return "";
}

function expandCommentPlaceholder(value: unknown, comment: string): unknown {
  if (!comment) {
    return value;
  }
  if (typeof value === "string") {
    return value === "__COMMENT_ID__" ? comment : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandCommentPlaceholder(item, comment));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = expandCommentPlaceholder(child, comment);
    }
    return out;
  }
  return value;
}

function listRegularFiles(dir: string): string[] {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return names.map((name) => join(dir, name));
}

function failCodeFromName(name: string): number | null {
  const match = name.match(/fail-(\d+)/);
  if (!match?.[1]) {
    return null;
  }
  return Number(match[1]);
}

export class LinearTransport {
  private fixtureIndex = 0;
  private recordIndex = 0;
  private readonly options: TransportOptions;

  constructor(options: TransportOptions = {}) {
    this.options = options;
  }

  async call(operation: string, payload: GraphqlPayload): Promise<TransportResult> {
    const fixtureDir = this.options.fixtureDir ?? process.env.FM_LINEAR_FIXTURE_DIR;
    if (fixtureDir) {
      return this.callFixture(operation, payload, fixtureDir);
    }
    return this.callLive(operation, payload);
  }

  private callFixture(operation: string, payload: GraphqlPayload, dir: string): TransportResult {
    const files = listRegularFiles(dir);
    const file = files[this.fixtureIndex];
    this.fixtureIndex += 1;
    if (!file) {
      return fail(operation, "fixture", `fixture response missing for ${operation}`);
    }
    const logPath = this.options.fixtureLog ?? process.env.FM_LINEAR_FIXTURE_LOG;
    if (logPath) {
      appendFileSync(logPath, `${operation}\t${JSON.stringify(payload)}\n`);
    }
    const base = file.split("/").pop() ?? file;
    const failCode = failCodeFromName(base);
    if (failCode !== null) {
      return fail(operation, "http", `HTTP ${failCode} during ${operation}`, {
        httpStatus: failCode,
      });
    }
    if (base.includes("malformed")) {
      try {
        copyFileSync(file, file);
      } catch {
        // The live bash copies into a response file; we only need the diagnostic.
      }
      return fail(operation, "malformed", `malformed JSON during ${operation}`);
    }
    let rawText: string;
    try {
      rawText = readFileSync(file, "utf8");
    } catch {
      return fail(operation, "fixture", `cannot read fixture for ${operation}`);
    }
    const parsed = parseJsonObject(rawText);
    if (!parsed) {
      return fail(operation, "malformed", `malformed JSON during ${operation}`);
    }
    const expanded = expandCommentPlaceholder(parsed, commentPlaceholder(payload));
    return this.interpretGraphql(operation, expanded);
  }

  private async callLive(operation: string, payload: GraphqlPayload): Promise<TransportResult> {
    const apiKey = this.options.apiKey ?? process.env.LINEAR_API_KEY ?? "";
    if (!apiKey) {
      return fail(operation, "transport", `missing API key during ${operation}`);
    }
    const timeoutSeconds =
      this.options.timeoutSeconds ??
      Number(process.env.FM_LINEAR_HTTP_TIMEOUT ?? DEFAULT_HTTP_TIMEOUT_SECONDS);
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.max(1, timeoutSeconds) * 1000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(operation, "transport", `transport failure during ${operation}: ${message}`);
    }
    const text = await response.text();
    if (response.status < 200 || response.status > 299) {
      const retryHeader = response.headers.get("retry-after");
      let retryAfterSeconds: number | undefined;
      if (retryHeader) {
        const seconds = Number(retryHeader);
        if (Number.isFinite(seconds) && seconds >= 0) retryAfterSeconds = Math.ceil(seconds);
        else {
          const date = Date.parse(retryHeader);
          if (Number.isFinite(date)) retryAfterSeconds = Math.max(0, Math.ceil((date - Date.now()) / 1000));
        }
      }
      const retry = retryAfterSeconds === undefined ? "" : ` retry-after=${retryAfterSeconds}`;
      return fail(operation, "http", `HTTP ${response.status} during ${operation}${retry}`, { httpStatus: response.status, retryAfterSeconds });
    }
    const parsed = parseJsonObject(text);
    if (!parsed) {
      return fail(operation, "malformed", `malformed JSON during ${operation}`);
    }
    const recordDir = this.options.recordDir ?? process.env.FM_LINEAR_RECORD_DIR;
    if (recordDir) {
      mkdirSync(recordDir, { recursive: true, mode: 0o700 });
      this.recordIndex += 1;
      const safeOperation = operation.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 64);
      const path = join(recordDir, `${String(this.recordIndex).padStart(4, "0")}-${safeOperation}.json`);
      writeFileSync(path, `${JSON.stringify(redactFixture(parsed), null, 2)}\n`, { mode: 0o600 });
    }
    return this.interpretGraphql(operation, parsed);
  }

  private interpretGraphql(operation: string, raw: unknown): TransportResult {
    const record = raw as { errors?: GraphqlError[]; data?: unknown };
    if (Array.isArray(record.errors) && record.errors.length > 0) {
      const messages = record.errors
        .map((error) => error.message)
        .filter((message): message is string => Boolean(message));
      return fail(
        operation,
        "graphql",
        `GraphQL error during ${operation}: ${messages.join("; ")}`,
        { graphqlErrors: record.errors },
      );
    }
    return { ok: true, value: { operation, data: record.data ?? raw, raw } };
  }
}

export async function apiCall(
  operation: string,
  payload: GraphqlPayload,
  options: TransportOptions = {},
): Promise<TransportResult> {
  return new LinearTransport(options).call(operation, payload);
}

// Used by fixture tests that need to write a consumed response the way bash did.
export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}
