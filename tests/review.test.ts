import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decode } from "@toon-format/toon";
import { ReviewMismatch, ReviewOutput } from "../scripts/review-output";

test("a deliberate contract failure passes the review only when expected; unverified evidence fails", () => {
  const output: string[] = [];
  const review = new ReviewOutput("compatibility", "json", false, (text) => output.push(text));
  review.step("Broken contract");
  review.expect("Failure detected", "failed", "failed");
  review.step("Restore contract");
  expect(() => review.expect("Restored", "not-verified", "passed")).toThrow(ReviewMismatch);
  review.finish();
  expect(output.length).toBe(1);
  const result = JSON.parse(output[0] ?? "");
  expect(result.status).toBe("failed");
  expect(result.steps[0].checks[0].status).toBe("passed");
  expect(result.steps[1].checks[0]).toMatchObject({
    actual: "not-verified",
    expected: "passed",
    status: "failed",
  });
});

test("JSON and TOON carry the same result without progress, including punctuation and multiline details", () => {
  const outputs = ["json", "toon"] as const;
  const parsed = outputs.map((format) => {
    const lines: string[] = [];
    const review = new ReviewOutput("messages", format, true, (text) => lines.push(text));
    review.say("Progress must not appear on stdout");
    review.step("Reply");
    review.expect("Correlated", true, true);
    review.detail("Fixture reply", {
      text: 'A, B: "quoted"\nSecond line 🏄',
      path: "/tmp/review file",
      absent: null,
    });
    review.finish();
    expect(lines.length).toBe(1);
    return format === "json" ? JSON.parse(lines[0] ?? "") : decode(lines[0] ?? "");
  });
  expect(parsed[0]).toEqual(parsed[1]);
});

async function run(args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("machine formats return one parseable failure document and exit 2 for missing configuration", async () => {
  for (const format of ["json", "toon"]) {
    const result = await run(["scripts/review.ts", "compatibility", "--format", format], {
      ...process.env,
      FIRSTMATE_SOURCE: "",
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    const parsed = (format === "json" ? JSON.parse(result.stdout) : decode(result.stdout)) as {
      status: string;
      errors: { code: string }[];
    };
    expect(parsed.status).toBe("failed");
    expect(parsed.errors[0]?.code).toBe("review.invalid_arguments");
  }
});

test("the actual review command exits 1 instead of continuing when a capability is unverified", async () => {
  if (!process.env.FIRSTMATE_SOURCE)
    throw new Error("Set FIRSTMATE_SOURCE for the isolated review process test.");
  const root = await mkdtemp(join(tmpdir(), "fm-review-contract-"));
  try {
    // Catches: printing a failed report while the real review entry point exits zero.
    // Replace only the reported check outcome; package binding still uses disposable upstream fixtures.
    const preload = join(root, "outcome.ts");
    await writeFile(
      preload,
      `import {FirstmateAdapter} from ${JSON.stringify(resolve("src/firstmate/adapter.ts"))};
FirstmateAdapter.prototype.testFirstmateInstallation = async function () {
return {schemaVersion:1,checkId:'fixture',installation:this.installation,adapterVersion:'fixture',suiteVersion:'fixture',checkedAt:new Date().toISOString(),capabilities:['task-state','briefs','messages'].map(capability=>({capability,status:'not-verified',evidence:['Injected incomplete check']}))};
};`,
    );
    const result = await run(
      ["--preload", preload, "scripts/review.ts", "compatibility", "--format", "json"],
      process.env,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("failed");
    expect(report.steps.length).toBe(1);
    expect(report.steps[0].checks.at(-1)).toMatchObject({
      expected: "passed",
      actual: "not-verified",
      status: "failed",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
