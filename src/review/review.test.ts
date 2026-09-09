import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checkReview, scaffoldReview } from "./review.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("review walkthrough", () => {
  test("scaffold is deliberately incomplete until every section is authored", () => {
    const root = mkdtempSync("/private/tmp/fml-review-"); roots.push(root);
    const path = join(root, "walkthrough.html");
    scaffoldReview({ issue: "ABC-1", title: "Feature", output: path });
    expect(checkReview(path)).toEqual(["placeholder content remains"]);
  });
});
