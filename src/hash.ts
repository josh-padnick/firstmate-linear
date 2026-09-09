import { createHash, randomUUID } from "node:crypto";

export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function uuid(): string {
  return randomUUID();
}
