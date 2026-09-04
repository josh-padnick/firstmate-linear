import { expect, test } from "bun:test";
import { renderRemoteRingCheck } from "./remote-ring.ts";

test("remote ring is a silent registered check until an inbox record ages out", () => {
  const script = renderRemoteRingCheck(180);
  expect(script).toContain("*.inbox/[0-9]*.msg");
  expect(script).toContain("older than 180s");
  expect(script).not.toContain("tmux");
});
