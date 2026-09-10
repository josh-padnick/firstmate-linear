import { encode } from "@toon-format/toon";

export type ReviewFormat = "human" | "json" | "toon";
type Value = string | number | boolean | null;
interface ReviewCheck {
  name: string;
  expected: Value;
  actual: Value;
  status: "passed" | "failed";
}
export interface ReviewResult {
  schemaVersion: 1;
  scenario: string;
  status: "passed" | "failed";
  steps: { title: string; checks: ReviewCheck[] }[];
  details: { title: string; value: unknown }[];
  errors: { code: string; summary: string; nextAction: string }[];
}
export class ReviewMismatch extends Error {}

/** One result feeds all renderers; expectations are enforced before any success summary. */
export class ReviewOutput {
  readonly result: ReviewResult;
  constructor(
    scenario: string,
    readonly format: ReviewFormat,
    readonly verbose = false,
    private readonly write: (text: string) => void = console.log,
  ) {
    this.result = {
      schemaVersion: 1,
      scenario,
      status: "passed",
      steps: [],
      details: [],
      errors: [],
    };
  }
  say(text: string) {
    if (this.format === "human") this.write(text);
  }
  step(title: string) {
    this.result.steps.push({ title, checks: [] });
    this.say(`\n${this.result.steps.length}. ${title}`);
  }
  expect(name: string, actual: Value, expected: Value) {
    const step = this.result.steps.at(-1);
    if (!step) throw new Error("A review check requires a step");
    const status = actual === expected ? "passed" : "failed";
    step.checks.push({ name, actual, expected, status });
    this.say(`   ${status === "passed" ? "PASS" : "FAIL"}  ${name}`);
    if (status === "failed") {
      this.result.status = "failed";
      this.say(
        `         Expected: ${JSON.stringify(expected)}\n         Received: ${JSON.stringify(actual)}`,
      );
      throw new ReviewMismatch(name);
    }
  }
  detail(title: string, value: unknown) {
    this.result.details.push({ title, value });
    if (this.verbose) this.say(`\n${title}\n${JSON.stringify(value, null, 2)}`);
  }
  fail(error: ReviewResult["errors"][number]) {
    this.result.status = "failed";
    this.result.errors.push(error);
    this.say(`\nERROR  ${error.summary}\n       ${error.nextAction} (${error.code})`);
  }
  finish() {
    if (this.format === "human") {
      this.say(
        this.result.status === "passed"
          ? "\nAll review checks passed.\n"
          : "\nReview failed. See the mismatch or error above.\n",
      );
    } else {
      this.write(
        this.format === "json" ? JSON.stringify(this.result, null, 2) : encode(this.result),
      );
    }
  }
}
