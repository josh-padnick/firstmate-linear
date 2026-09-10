import { FmError } from "./errors";

export async function boundedStdin(limit = 65536): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of Bun.stdin.stream()) {
    size += chunk.byteLength;
    if (size > limit) throw new FmError("config.invalid", "The input exceeds the supported size.");
    chunks.push(chunk);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}
