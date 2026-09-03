// UTC-only ISO-8601 timestamps.
// Replaces fm_linear_epoch / fm_linear_iso_from_epoch (the DST-bug site).
// Invariant: parseIso(formatIso(epoch)) === epoch for every finite integer epoch.

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

export const DEFAULT_OVERLAP_SECONDS = 300;

export function parseIso(timestamp: string): number | null {
  const match = timestamp.trim().match(ISO_RE);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second)
  ) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = match[8];
  if (offset && offset !== "Z") {
    const sign = offset.startsWith("-") ? -1 : 1;
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (!Number.isInteger(offsetHour) || !Number.isInteger(offsetMinute)) {
      return null;
    }
    utcMs -= sign * (offsetHour * 3600 + offsetMinute * 60) * 1000;
  }
  if (!Number.isFinite(utcMs)) {
    return null;
  }
  return Math.floor(utcMs / 1000);
}

export function formatIso(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) {
    throw new Error(`invalid epoch: ${epochSeconds}`);
  }
  const epoch = Math.trunc(epochSeconds);
  const date = new Date(epoch * 1000);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid epoch: ${epochSeconds}`);
  }
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`
  );
}

// Lexicographic ISO compare is unsafe: "23:44:00.801Z" < "23:44:00Z"
// because "." sorts before "Z", even though the fractional instant is later.
export function isoAtOrAfter(candidate: string, baseline: string): boolean {
  const left = parseIso(candidate);
  const right = parseIso(baseline);
  if (left === null || right === null) {
    return false;
  }
  return left >= right;
}

export function compareIso(left: string, right: string): -1 | 0 | 1 | null {
  const leftMatch = left.trim().match(ISO_RE);
  const rightMatch = right.trim().match(ISO_RE);
  const leftSeconds = parseIso(left);
  const rightSeconds = parseIso(right);
  if (!leftMatch || !rightMatch || leftSeconds === null || rightSeconds === null) return null;
  const fraction = (match: RegExpMatchArray): bigint => BigInt((match[7] ?? "").slice(0, 9).padEnd(9, "0"));
  const leftInstant = BigInt(leftSeconds) * 1_000_000_000n + fraction(leftMatch);
  const rightInstant = BigInt(rightSeconds) * 1_000_000_000n + fraction(rightMatch);
  return leftInstant < rightInstant ? -1 : leftInstant > rightInstant ? 1 : 0;
}

export function overlapTimestamp(
  timestamp: string,
  overlapSeconds: number = DEFAULT_OVERLAP_SECONDS,
): string | null {
  const epoch = parseIso(timestamp);
  if (epoch === null) {
    return null;
  }
  return formatIso(epoch - overlapSeconds);
}

export function nowEpoch(env: NodeJS.ProcessEnv = process.env): number {
  const override = env.FM_LINEAR_NOW_EPOCH?.trim();
  if (override) {
    const parsed = Number(override);
    if (!Number.isFinite(parsed)) {
      throw new Error(`invalid FM_LINEAR_NOW_EPOCH: ${override}`);
    }
    return Math.trunc(parsed);
  }
  return Math.floor(Date.now() / 1000);
}

export function nowIso(env: NodeJS.ProcessEnv = process.env): string {
  return formatIso(nowEpoch(env));
}

const SELF_TEST_EPOCHS = [
  0,
  1,
  1786724151,
  // America/New_York 2026 spring-forward local 02:00 (UTC 07:00).
  1772953200,
  // America/New_York 2026 fall-back local 01:00 EST (UTC 06:00).
  1793512800,
  // Phoenix has no DST; a midsummer noon still rounds through UTC.
  1784001600,
];

export function assertParseRoundTrip(epochs: readonly number[] = SELF_TEST_EPOCHS): void {
  for (const epoch of epochs) {
    const formatted = formatIso(epoch);
    const parsed = parseIso(formatted);
    if (parsed !== epoch) {
      throw new Error(`parse(format(${epoch})) === ${String(parsed)} (${formatted})`);
    }
  }
}

export function parseRoundTripOk(): boolean {
  try {
    assertParseRoundTrip();
    return true;
  } catch {
    return false;
  }
}
