import { expect, test } from "bun:test";
import { controlProbe, watchdogShouldRestart } from "./service.ts";

test("watchdog restarts only after the threshold when the control network works", async () => {
  expect(watchdogShouldRestart(5, 6, true)).toBe(false);
  expect(watchdogShouldRestart(6, 6, true)).toBe(true);
  expect(watchdogShouldRestart(6, 6, false)).toBe(false);
  expect(await controlProbe("https://probe.test", async () => new Response("ok", { status: 200 }))).toBe(true);
  expect(await controlProbe("https://probe.test", async () => { throw new Error("offline"); })).toBe(false);
});
