import { existsSync, readFileSync, statSync } from "node:fs";
import { sha256 } from "../hash.ts";

export function fileIncarnation(path: string): string | null {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

export function sidecarGeneration(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  const match = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`).exec(content);
  return match?.[1] ? `gen:${match[1]}` : `file:${fileIncarnation(path)}:${sha256(content)}`;
}

export function statusFileState(path: string, rawCursor: string | null): {
  content: Buffer;
  physicalIdentity: string;
  incarnationIdentity: string;
  offset: number;
  needsPersistence: boolean;
} | null {
  const physicalIdentity = fileIncarnation(path);
  if (!physicalIdentity) return null;
  const content = readFileSync(path);
  let offset = 0;
  let incarnationIdentity = physicalIdentity;
  let needsPersistence = false;
  if (!rawCursor) return { content, physicalIdentity, incarnationIdentity, offset, needsPersistence };
  try {
    const cursor = JSON.parse(rawCursor) as { offset?: number; file_identity?: string; physical_identity?: string; prefix_sha?: string; identity?: string };
    const candidate = Number(cursor.offset ?? 0);
    const validOffset = Number.isInteger(candidate) && candidate >= 0 && candidate <= content.length;
    const modern = typeof cursor.file_identity === "string" || typeof cursor.prefix_sha === "string";
    const legacyIdentityMatches = typeof cursor.identity !== "string"
      || cursor.identity === physicalIdentity
      || cursor.identity.startsWith(`${physicalIdentity}:`);
    const cursorPhysicalIdentity = cursor.physical_identity ?? cursor.file_identity;
    const modernMatches = cursorPhysicalIdentity === physicalIdentity
      && cursor.prefix_sha === sha256(content.subarray(0, candidate));
    if (validOffset && ((!modern && legacyIdentityMatches) || modernMatches)) {
      offset = candidate;
      incarnationIdentity = cursor.file_identity ?? physicalIdentity;
    } else if (modern && cursorPhysicalIdentity === physicalIdentity) {
      incarnationIdentity = `${physicalIdentity}:reset:${sha256(content)}`;
      needsPersistence = true;
    }
  } catch {}
  return { content, physicalIdentity, incarnationIdentity, offset, needsPersistence };
}

export function statusCursorValue(state: NonNullable<ReturnType<typeof statusFileState>>, offset: number): string {
  return JSON.stringify({
    offset,
    file_identity: state.incarnationIdentity,
    physical_identity: state.physicalIdentity,
    prefix_sha: sha256(state.content.subarray(0, offset)),
  });
}

export function statusFileVersion(state: ReturnType<typeof statusFileState>): string {
  if (!state) return "missing";
  return sha256(JSON.stringify({
    physicalIdentity: state.physicalIdentity,
    incarnationIdentity: state.incarnationIdentity,
    content: sha256(state.content),
  }));
}
