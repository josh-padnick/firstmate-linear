import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowConfig } from "../config/schema.ts";
import { StateDatabase } from "../db/database.ts";
import { LinearTransport } from "../transport.ts";
import { nextAttempt, processJobs } from "./worker.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const statuses = { backlog: "Backlog", todo: "ToDo", prioritized: "Prioritized", waiting: "Waiting", plan_in_progress: "Plan In Progress", approve_plan: "Approve Plan", building: "Building", validating_code: "Validating Code", approve_deliverable: "Approve Deliverable", needs_decision: "Needs Decision", needs_firstmate_decision: "Needs Firstmate Decision", done: "Done", canceled: "Canceled", duplicate: "Duplicate" } as const;
const config: WorkflowConfig = { version: 1, captain: { display_name: "Captain" }, teams: [{ key: "ABC", projects: [], managed: "all", statuses: { ...statuses }, agent_labels: {} }], features: { relay: "off", mirror: "off", escalation: "off" }, templates: { reply: "", report: "", review_walkthrough: "" }, sourcePath: "test" };

describe("job worker", () => {
  test("Retry-After extends exponential backoff", () => {
    const job = { id: "job:1", key: "key", kind: "test", target: "ABC-1", payload: "{}", state: "running", attempts: 1, next_attempt_at: "", native_id: null, last_error: null, created_at: "", done_at: null } as const;
    expect(nextAttempt(job, { FM_LINEAR_NOW_EPOCH: "1000" }, 120)).toBe("1970-01-01T00:18:40Z");
  });
  test("a state job conditionally updates and comments", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { viewer: { id: "me", displayName: "Firstmate" }, issue: { id: "issue-id", state: { id: "old", name: "Approve Deliverable" }, team: { states: { nodes: [{ id: "new", name: "Validating Code" }] }, members: { nodes: [] } } } } }));
    await Bun.write(join(fixtures, "02-update.json"), JSON.stringify({ data: { issueUpdate: { success: true, issue: { id: "issue-id", state: { name: "Validating Code" } } } } }));
    await Bun.write(join(fixtures, "03-comment.json"), JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "comment-id" } } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.enqueue({ key: "approve:1", kind: "linear.issue-state", target: "ABC-1", payload: { issue: "ABC-1", state: "Validating Code", expected_state: "Approve Deliverable", comment: "Approved." } }, "2026-01-01T00:00:00Z");
    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" } });
    expect(result.done).toBe(1);
    expect(db.jobs()[0]?.state).toBe("done");
    db.close();
  });

  test("an ambiguous comment failure verifies the native client id and does not duplicate", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-fail-500.json"), "{}");
    const expectedId = "0f425027-ec05-4429-a159-e981bb14f01c";
    await Bun.write(join(fixtures, "02-verify.json"), JSON.stringify({ data: { comment: { id: expectedId } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.enqueue({ key: "comment:key", kind: "linear.comment", target: "ABC-1", payload: { issue: "ABC-1", body: "Hello" } }, "2026-01-01T00:00:00Z");
    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" } });
    expect(result.done).toBe(1);
    expect(db.jobs()[0]?.native_id).toBe(expectedId);
    db.close();
  });

  test("an ambiguous attachment failure verifies the URL and does not duplicate", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    const url = "https://github.com/example/repo/pull/42";
    await Bun.write(join(fixtures, "01-resolve.json"), JSON.stringify({ data: { issue: { id: "issue-id", attachments: { nodes: [] } } } }));
    await Bun.write(join(fixtures, "02-fail-500.json"), "{}");
    await Bun.write(join(fixtures, "03-verify.json"), JSON.stringify({ data: { issue: { id: "issue-id", attachments: { nodes: [{ id: "attachment-id", url }] } } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.enqueue({ key: "attachment:key", kind: "linear.attachment", target: "ABC-1", payload: { issue: "ABC-1", url } }, "2026-01-01T00:00:00Z");
    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" } });
    expect(result.done).toBe(1);
    expect(db.jobs()[0]?.native_id).toBe("attachment-id");
    db.close();
  });

  test("a receipt acknowledgement reaches Firstmate core through the outbox", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const firstmate = join(root, "firstmate");
    const bin = join(firstmate, "bin");
    mkdirSync(bin, { recursive: true });
    const calls = join(root, "handled.txt");
    const script = join(bin, "fm-procevent.sh");
    writeFileSync(script, `#!/bin/sh\nprintf '%s %s %s\\n' "$1" "$2" "$3" >> "${calls}"\n`);
    chmodSync(script, 0o755);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.capture({ id: "event:ack", team: "ABC", issue: "ABC-1", type: "comment", token: "comment", author: "Captain", body_sha: null, created_at: "2026-01-01T00:00:00Z", captured_at: "2026-01-01T00:00:01Z", disposition: "waiting-for-core", note: null, raw_ref: "{}" });
    db.nextForCore("request:ack", 0);
    db.bindDeliverySequence("event:ack", 9);
    const receipt = db.issueReceipt(["event:ack"]);
    db.handleWithReceipt("event:ack", receipt, "handled", "2026-01-01T00:00:02Z");
    const env = { FM_HOME: root, FM_ROOT_OVERRIDE: firstmate, FM_LINEAR_NOW_EPOCH: "1767225603" };
    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: join(root, "unused") }), env });
    expect(result.done).toBe(1);
    expect(readFileSync(calls, "utf8")).toBe("handled linear-main 9\n");
    expect(db.deliveryForEvent("event:ack")?.handled_at).not.toBeNull();
    db.close();
  });

  test("relay becomes silently handled only after durable steering succeeds", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
    const script = join(bin, "fm-send.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n"); chmodSync(script, 0o755);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.capture({ ...eventRecord("event:relay"), disposition: "classified" }, [{ key: "event:relay:relay", kind: "relay", target: "ABC-1", payload: { event_id: "event:relay", issue: "ABC-1", task: "task-1", key: "choice" } }]);
    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: join(root, "unused") }), env: { FM_HOME: root }, maxAttempts: 1 });
    expect(result.done).toBe(1);
    expect(db.event("event:relay")?.disposition).toBe("handled-by-service");
    db.close();
  });

  test("a terminal relay failure falls back to a core-visible event", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
    const script = join(bin, "fm-send.sh");
    writeFileSync(script, "#!/bin/sh\necho refused >&2\nexit 1\n"); chmodSync(script, 0o755);
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.capture({ ...eventRecord("event:relay-failed"), disposition: "classified" }, [{ key: "event:relay-failed:relay", kind: "relay", target: "ABC-1", payload: { event_id: "event:relay-failed", issue: "ABC-1", task: "task-1", key: "choice" } }]);
    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: join(root, "unused") }), env: { FM_HOME: root }, maxAttempts: 1 });
    expect(result.dead).toBe(1);
    expect(db.event("event:relay-failed")?.disposition).toBe("waiting-for-core");
    db.close();
  });

  test("apply-labels creates only the workspace Agent group", async () => {
    const root = mkdtempSync("/private/tmp/fml-jobs-"); roots.push(root);
    const fixtures = join(root, "fixtures"); mkdirSync(fixtures);
    await Bun.write(join(fixtures, "01-labels.json"), JSON.stringify({ data: { issueLabels: { nodes: [] } } }));
    await Bun.write(join(fixtures, "02-create.json"), JSON.stringify({ data: { issueLabelCreate: { success: true, issueLabel: { id: "agent-group", name: "Agent", isGroup: true } } } }));
    const db = new StateDatabase(join(root, "db"), join(root, "backups"));
    db.enqueue({ key: "labels:agent", kind: "linear.label-group", target: "Agent", payload: { name: "Agent" } }, "2026-01-01T00:00:00Z");
    const result = await processJobs({ db, config, transport: new LinearTransport({ fixtureDir: fixtures }), env: { FM_HOME: root, FM_LINEAR_NOW_EPOCH: "1767225600" } });
    expect(result.done).toBe(1);
    expect(db.jobs()[0]?.native_id).toBe("agent-group");
    db.close();
  });
});

function eventRecord(id: string) {
  return {
    id, team: "ABC", issue: "ABC-1", type: "comment", token: "comment", author: "Captain",
    body_sha: null, created_at: "2026-01-01T00:00:00Z", captured_at: "2026-01-01T00:00:01Z",
    disposition: "waiting-for-core" as const, note: null, raw_ref: "{}",
  };
}
