import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertParseRoundTrip,
  formatIso,
  isoAtOrAfter,
  overlapTimestamp,
  parseIso,
  parseRoundTripOk,
} from "./time.ts";

const KNOWN_TIMESTAMP = "2026-08-14T16:15:51.321Z";
const KNOWN_EPOCH = 1786724151;
const KNOWN_FORMATTED = "2026-08-14T16:15:51Z";
const ZONES = ["UTC", "America/Phoenix", "America/New_York"] as const;
const SRC = dirname(fileURLToPath(import.meta.url));

describe("parseIso / formatIso", () => {
  test("ports the bash known-timestamp case", () => {
    expect(parseIso(KNOWN_TIMESTAMP)).toBe(KNOWN_EPOCH);
    expect(formatIso(KNOWN_EPOCH)).toBe(KNOWN_FORMATTED);
    expect(parseIso(KNOWN_FORMATTED)).toBe(KNOWN_EPOCH);
  });

  test("strips fractional seconds the way jq did", () => {
    expect(parseIso("2026-08-14T16:15:51.999Z")).toBe(KNOWN_EPOCH);
    expect(parseIso("2026-08-14T16:15:51.1Z")).toBe(KNOWN_EPOCH);
  });

  test("accepts numeric offsets without consulting the host zone", () => {
    expect(parseIso("2026-08-14T09:15:51-07:00")).toBe(KNOWN_EPOCH);
    expect(parseIso("2026-08-14T12:15:51-04:00")).toBe(KNOWN_EPOCH);
  });

  test("rejects garbage instead of guessing", () => {
    expect(parseIso("")).toBeNull();
    expect(parseIso("not-a-date")).toBeNull();
    expect(parseIso("2026-08-14 16:15:51Z")).toBeNull();
    expect(parseIso("2026-13-01T00:00:00Z")).toBeNull();
  });

  test("round-trip property holds for the self-test epochs", () => {
    expect(parseRoundTripOk()).toBe(true);
    expect(() => assertParseRoundTrip()).not.toThrow();
  });

  test("fractional seconds compare by epoch, not string order", () => {
    expect("2026-08-14T23:44:00.801Z" < "2026-08-14T23:44:00Z").toBe(true);
    expect(isoAtOrAfter("2026-08-14T23:44:00.801Z", "2026-08-14T23:44:00Z")).toBe(true);
    expect(isoAtOrAfter("2026-08-14T23:43:59Z", "2026-08-14T23:44:00Z")).toBe(false);
  });

  test("overlap subtracts five minutes in UTC", () => {
    expect(overlapTimestamp(KNOWN_TIMESTAMP)).toBe("2026-08-14T16:10:51Z");
    expect(overlapTimestamp(KNOWN_FORMATTED, 300)).toBe("2026-08-14T16:10:51Z");
    expect(overlapTimestamp("bad")).toBeNull();
  });
});

describe("timezone matrix", () => {
  for (const zone of ZONES) {
    test(`parse and format ignore host TZ=${zone}`, async () => {
      const probe = `
        import { parseIso, formatIso, overlapTimestamp, assertParseRoundTrip } from ${JSON.stringify(join(SRC, "time.ts"))};
        const epoch = parseIso(${JSON.stringify(KNOWN_TIMESTAMP)});
        const formatted = formatIso(epoch);
        const overlap = overlapTimestamp(${JSON.stringify(KNOWN_TIMESTAMP)});
        assertParseRoundTrip();
        console.log(JSON.stringify({ epoch, formatted, overlap, tz: process.env.TZ }));
      `;
      const proc = Bun.spawn({
        cmd: ["bun", "-e", probe],
        env: { ...process.env, TZ: zone },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      const payload = JSON.parse(stdout) as {
        epoch: number;
        formatted: string;
        overlap: string;
        tz: string;
      };
      expect(payload.tz).toBe(zone);
      expect(payload.epoch).toBe(KNOWN_EPOCH);
      expect(payload.formatted).toBe(KNOWN_FORMATTED);
      expect(payload.overlap).toBe("2026-08-14T16:10:51Z");
    });
  }
});
