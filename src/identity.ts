import { sha256 } from "./hash.ts";

export function redactedIdentity(value: string): string {
  return `[redacted-${sha256(value).slice(0, 8)}]`;
}

export function identityMatches(actual: string | null | undefined, expected: string): boolean {
  return actual === expected || actual === redactedIdentity(expected);
}
