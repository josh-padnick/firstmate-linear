import { describe, expect, test } from "bun:test";
import { classifyFailure, type ClassifiableFailure, type ErrorClass } from "./errors.ts";

const cases: Array<{
  name: string;
  input: ClassifiableFailure;
  want: ErrorClass;
}> = [
  {
    name: "transport failure is retryable",
    input: { kind: "transport", message: "transport failure during comments" },
    want: "retryable",
  },
  {
    name: "HTTP 500 is retryable",
    input: { kind: "http", httpStatus: 500, message: "HTTP 500 during issues" },
    want: "retryable",
  },
  {
    name: "HTTP 429 is retryable",
    input: { kind: "http", httpStatus: 429, message: "HTTP 429 during comments" },
    want: "retryable",
  },
  {
    name: "RATELIMITED GraphQL code is retryable",
    input: {
      kind: "graphql",
      graphqlErrors: [{ message: "slow down", extensions: { code: "RATELIMITED" } }],
    },
    want: "retryable",
  },
  {
    name: "malformed JSON is retryable",
    input: { kind: "malformed", message: "malformed JSON during comments" },
    want: "retryable",
  },
  {
    name: "parent not found is precondition-changed",
    input: {
      kind: "graphql",
      message: "GraphQL error during commentCreate: Entity not found: Parent comment",
      graphqlErrors: [{ message: "Entity not found: Parent comment", extensions: { code: "NOT_FOUND" } }],
    },
    want: "precondition-changed",
  },
  {
    name: "incorrect parent spelling is precondition-changed",
    input: { kind: "graphql", message: "Incorrect parent specified for comment" },
    want: "precondition-changed",
  },
  {
    name: "argument-validation parent spelling is precondition-changed",
    input: { kind: "graphql", message: "Argument Validation Error on parentId" },
    want: "precondition-changed",
  },
  {
    name: "entity not found is precondition-changed",
    input: { kind: "graphql", message: "Entity not found" },
    want: "precondition-changed",
  },
  {
    name: "HTTP 404 is precondition-changed",
    input: { kind: "http", httpStatus: 404, message: "HTTP 404 during resolve" },
    want: "precondition-changed",
  },
  {
    name: "already exists is already-satisfied",
    input: { kind: "graphql", message: "comment already exists" },
    want: "already-satisfied",
  },
  {
    name: "duplicate spelling is already-satisfied",
    input: { kind: "graphql", message: "duplicate id taken" },
    want: "already-satisfied",
  },
  {
    name: "reaction insert conflict is already-satisfied",
    input: { kind: "graphql", message: "conflict on insert of Reaction" },
    want: "already-satisfied",
  },
  {
    name: "ALREADY_EXISTS code is already-satisfied",
    input: {
      kind: "graphql",
      graphqlErrors: [{ message: "exists", extensions: { code: "ALREADY_EXISTS" } }],
    },
    want: "already-satisfied",
  },
  {
    name: "validation failed is invalid-intent",
    input: {
      kind: "graphql",
      graphqlErrors: [{ message: "bad query", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }],
    },
    want: "invalid-intent",
  },
  {
    name: "authentication is invalid-intent",
    input: {
      kind: "graphql",
      graphqlErrors: [{ message: "nope", extensions: { code: "AUTHENTICATION_ERROR" } }],
    },
    want: "invalid-intent",
  },
  {
    name: "HTTP 401 is invalid-intent",
    input: { kind: "http", httpStatus: 401, message: "HTTP 401 during viewer" },
    want: "invalid-intent",
  },
  {
    name: "unclassified GraphQL is invalid-intent, never guessed",
    input: { kind: "graphql", message: "something novel happened" },
    want: "invalid-intent",
  },
];

describe("error classifier", () => {
  for (const row of cases) {
    test(row.name, () => {
      expect(classifyFailure(row.input).class).toBe(row.want);
    });
  }
});
