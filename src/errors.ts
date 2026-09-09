// Four-class Linear error taxonomy.
// Replaces the serial string-matching patches in ledger/fm-linear-act.sh:178-200.

export const ERROR_CLASSES = [
  "retryable",
  "precondition-changed",
  "already-satisfied",
  "invalid-intent",
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

export type GraphqlError = {
  message?: string;
  extensions?: {
    code?: string;
    type?: string;
    userError?: boolean;
    [key: string]: unknown;
  };
};

export type ClassifiableFailure = {
  kind?: "transport" | "http" | "malformed" | "graphql" | "fixture" | string;
  message?: string;
  httpStatus?: number;
  graphqlErrors?: GraphqlError[];
};

export type Classification = {
  class: ErrorClass;
  code: string;
  reason: string;
};

const GRAPHQL_CODE_TABLE: Record<string, ErrorClass> = {
  RATELIMITED: "retryable",
  RATE_LIMITED: "retryable",
  INTERNAL_ERROR: "retryable",
  INTERNAL_SERVER_ERROR: "retryable",
  TIMEOUT: "retryable",
  LOCKED: "retryable",
  NOT_FOUND: "precondition-changed",
  ENTITY_NOT_FOUND: "precondition-changed",
  INVALID_INPUT: "invalid-intent",
  INPUT_ERROR: "invalid-intent",
  GRAPHQL_VALIDATION_FAILED: "invalid-intent",
  GRAPHQL_PARSE_FAILED: "invalid-intent",
  AUTHENTICATION_ERROR: "invalid-intent",
  AUTHENTICATION_REQUIRED: "invalid-intent",
  FORBIDDEN: "invalid-intent",
  FEATURE_NOT_AVAILABLE: "invalid-intent",
  ALREADY_EXISTS: "already-satisfied",
  DUPLICATE: "already-satisfied",
};

function firstGraphqlCode(errors: GraphqlError[] | undefined): string {
  if (!errors) {
    return "";
  }
  for (const error of errors) {
    const code = error.extensions?.code;
    if (typeof code === "string" && code.trim()) {
      return code.trim().toUpperCase();
    }
  }
  return "";
}

function joinedMessages(failure: ClassifiableFailure): string {
  const parts: string[] = [];
  if (failure.message) {
    parts.push(failure.message);
  }
  for (const error of failure.graphqlErrors ?? []) {
    if (error.message) {
      parts.push(error.message);
    }
  }
  return parts.join("; ");
}

function looksAlreadySatisfied(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("already exist") ||
    lower.includes("already exists") ||
    lower.includes("duplicate") ||
    lower.includes("conflict on insert") ||
    /\btaken\b/.test(lower)
  );
}

function looksParentGone(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("incorrect parent") ||
    (lower.includes("parent") && lower.includes("not found")) ||
    (lower.includes("parent") && lower.includes("invalid")) ||
    (lower.includes("argument validation") && lower.includes("parent"))
  );
}

function looksEntityGone(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("entity not found") ||
    lower.includes("issue not found") ||
    lower.includes("comment not found")
  );
}

export function classifyFailure(failure: ClassifiableFailure): Classification {
  const message = joinedMessages(failure);
  const graphqlCode = firstGraphqlCode(failure.graphqlErrors);

  if (failure.kind === "transport" || failure.kind === "fixture") {
    return {
      class: "retryable",
      code: failure.kind.toUpperCase(),
      reason: message || "transport failure",
    };
  }

  if (failure.kind === "malformed") {
    return {
      class: "retryable",
      code: "MALFORMED",
      reason: message || "malformed JSON",
    };
  }

  const status = failure.httpStatus;
  if (typeof status === "number") {
    if (status === 429 || status === 408) {
      return { class: "retryable", code: `HTTP_${status}`, reason: message || `HTTP ${status}` };
    }
    if (status >= 500) {
      return { class: "retryable", code: `HTTP_${status}`, reason: message || `HTTP ${status}` };
    }
    if (status === 404) {
      return {
        class: "precondition-changed",
        code: "HTTP_404",
        reason: message || "HTTP 404",
      };
    }
    if (status === 401 || status === 403 || status === 400) {
      // Fall through to GraphQL/message rules when the body has them.
      if (!graphqlCode && !message) {
        return {
          class: "invalid-intent",
          code: `HTTP_${status}`,
          reason: `HTTP ${status}`,
        };
      }
    }
  }

  if (looksAlreadySatisfied(message)) {
    return { class: "already-satisfied", code: graphqlCode || "ALREADY_SATISFIED", reason: message };
  }

  if (graphqlCode && GRAPHQL_CODE_TABLE[graphqlCode]) {
    return {
      class: GRAPHQL_CODE_TABLE[graphqlCode],
      code: graphqlCode,
      reason: message || graphqlCode,
    };
  }
  if (looksParentGone(message) || looksEntityGone(message)) {
    return { class: "precondition-changed", code: graphqlCode || "PRECONDITION", reason: message };
  }

  if (failure.kind === "http" && typeof status === "number" && status >= 400) {
    return {
      class: "invalid-intent",
      code: `HTTP_${status}`,
      reason: message || `HTTP ${status}`,
    };
  }

  return {
    class: "invalid-intent",
    code: graphqlCode || "INVALID_INTENT",
    reason: message || "unclassified Linear failure",
  };
}

export function classifyGraphqlErrors(errors: GraphqlError[], message?: string): Classification {
  return classifyFailure({ kind: "graphql", message, graphqlErrors: errors });
}
