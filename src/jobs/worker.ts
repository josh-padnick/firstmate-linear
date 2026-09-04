import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { WorkflowConfig } from "../config/schema.ts";
import { StateDatabase, type Job } from "../db/database.ts";
import { resolveHome } from "../env.ts";
import { sha256 } from "../hash.ts";
import { nowEpoch, nowIso } from "../time.ts";
import { LinearTransport, type TransportResult } from "../transport.ts";

const RESOLVE_STATE = `query($issue:String!){viewer{id displayName} issue(id:$issue){id state{id name} team{states{nodes{id name}} members{nodes{id displayName}}}}}`;
const UPDATE_STATE = `mutation($issue:String!,$state:String!,$assignee:String){issueUpdate(id:$issue,input:{stateId:$state,assigneeId:$assignee}){success issue{id state{name} assignee{displayName}}}}`;
const CREATE_COMMENT = `mutation($id:String!,$issue:String!,$body:String!){commentCreate(input:{id:$id,issueId:$issue,body:$body}){success comment{id}}}`;
const VERIFY_COMMENT = `query($id:String!){comment(id:$id){id}}`;
const RESOLVE_ISSUE = `query($issue:String!){issue(id:$issue){id}}`;
const RESOLVE_ATTACHMENTS = `query($issue:String!){issue(id:$issue){id attachments{nodes{id url}}}}`;
const CREATE_ATTACHMENT = `mutation($issue:String!,$url:String!,$title:String!){attachmentCreate(input:{issueId:$issue,url:$url,title:$title}){success attachment{id url}}}`;
const RESOLVE_TEAM_STATES = `query($team:String!){team(id:$team){id states{nodes{id name type}}}}`;
const CREATE_WORKFLOW_STATE = `mutation($team:String!,$name:String!,$type:String!,$color:String!){workflowStateCreate(input:{teamId:$team,name:$name,type:$type,color:$color}){success workflowState{id name}}}`;
const RESOLVE_LABELS = `query($issue:String!){issue(id:$issue){id labels{nodes{id name}} team{labels{nodes{id name}}}}}`;
const UPDATE_LABELS = `mutation($issue:String!,$added:[String!],$removed:[String!]){issueUpdate(id:$issue,input:{addedLabelIds:$added,removedLabelIds:$removed}){success issue{id labels{nodes{name}}}}}`;
const RESOLVE_LABEL_GROUP = `query($name:String!){issueLabels(first:50,filter:{name:{eq:$name}}){nodes{id name isGroup team{id}}}}`;
const CREATE_LABEL_GROUP = `mutation($name:String!){issueLabelCreate(input:{name:$name,isGroup:true,color:"#6B7280"}){success issueLabel{id name isGroup}}}`;
const RESOLVE_MANAGED = `query($issue:String!){viewer{displayName} issue(id:$issue){identifier assignee{displayName} project{name slugId}}}`;

export type JobPayload = Record<string, unknown>;

export type JobOutcome = {
  nativeId?: string | null;
  followups?: Array<{ key: string; kind: string; target: string; payload: unknown }>;
};

function payload(job: Job): JobPayload {
  const parsed = JSON.parse(job.payload) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("job payload is not an object");
  return parsed as JobPayload;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`job payload missing ${name}`);
  return value;
}

function nativeUuid(key: string): string {
  const hex = sha256(key);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function value(result: TransportResult): any {
  if (!result.ok) throw new Error(result.error.message);
  return result.value.data;
}

async function updateIssueState(job: Job, body: JobPayload, transport: LinearTransport, config: WorkflowConfig): Promise<JobOutcome> {
  const issue = requiredString(body.issue ?? job.target, "issue");
  const target = requiredString(body.state, "state");
  const resolved = value(await transport.call("job-resolve-state", { query: RESOLVE_STATE, variables: { issue } }));
  if (!resolved?.issue?.id) throw new Error(`issue not found: ${issue}`);
  const note = typeof body.comment === "string" ? body.comment.trim() : "";
  const outcome = (): JobOutcome => ({
    nativeId: resolved.issue.id,
    followups: note ? [{
      key: `${job.key}:comment`, kind: "linear.comment", target: issue,
      payload: { issue, body: note, requires_managed: body.requires_managed === true || undefined },
    }] : undefined,
  });
  if (resolved.issue.state?.name === target) return outcome();
  const expected = typeof body.expected_state === "string" ? body.expected_state : null;
  if (expected && resolved.issue.state?.name !== expected) {
    throw new Error(`precondition changed: ${issue} is ${resolved.issue.state?.name}, expected ${expected}`);
  }
  const state = resolved.issue.team?.states?.nodes?.find((item: any) => item.name === target);
  if (!state?.id) throw new Error(`target status not found: ${target}`);
  const teamKey = issue.slice(0, issue.indexOf("-")).toUpperCase();
  const team = config.teams.find((item) => item.key === teamKey);
  const captainStates = new Set([team?.statuses.approve_plan, team?.statuses.approve_deliverable, team?.statuses.needs_decision]);
  let assigneeId: string | null = resolved.viewer?.id ?? null;
  if (captainStates.has(target)) {
    const captain = resolved.issue.team?.members?.nodes?.find((item: any) => item.displayName === config.captain.display_name);
    if (!captain?.id) throw new Error(`captain not found in ${teamKey}: ${config.captain.display_name}`);
    assigneeId = captain.id;
  } else if (!assigneeId) {
    throw new Error("Linear viewer identity is unavailable; refusing to clear the assignee");
  }
  const updated = value(await transport.call("job-update-state", {
    query: UPDATE_STATE,
    variables: { issue: resolved.issue.id, state: state.id, assignee: assigneeId },
  }));
  if (!updated?.issueUpdate?.success) throw new Error(`issue update was not successful: ${issue}`);
  return outcome();
}

async function createComment(job: Job, body: JobPayload, transport: LinearTransport, db?: StateDatabase): Promise<JobOutcome> {
  const stillWaiting = (): boolean => {
    if (typeof body.waiting_event_id !== "string") return true;
    if (!db) throw new Error("guarded comment requires the state database");
    return db.event(body.waiting_event_id)?.disposition === "waiting-for-core";
  };
  if (!stillWaiting()) return {};
  const issue = requiredString(body.issue ?? job.target, "issue");
  const text = requiredString(body.body, "body");
  const id = nativeUuid(job.key);
  const resolved = value(await transport.call("job-resolve-comment-issue", { query: RESOLVE_ISSUE, variables: { issue } }));
  if (!resolved?.issue?.id) throw new Error(`issue not found: ${issue}`);
  if (!stillWaiting()) return {};
  const result = await transport.call("job-comment", { query: CREATE_COMMENT, variables: { id, issue: resolved.issue.id, body: text } });
  if (result.ok) {
    if (!(result.value.data as any)?.commentCreate?.success) throw new Error(`comment creation was not successful: ${issue}`);
    return { nativeId: id };
  }
  if (result.error.classification.class !== "already-satisfied" && result.error.classification.class !== "retryable") {
    throw new Error(result.error.message);
  }
  const verify = await transport.call("job-comment-verify", { query: VERIFY_COMMENT, variables: { id } });
  if (verify.ok && (verify.value.data as any)?.comment?.id === id) return { nativeId: id };
  throw new Error(result.error.message);
}

async function createAttachment(job: Job, body: JobPayload, transport: LinearTransport): Promise<JobOutcome> {
  const issue = requiredString(body.issue ?? job.target, "issue");
  const url = requiredString(body.url, "url");
  const title = typeof body.title === "string" ? body.title : url;
  const resolve = async (): Promise<{ issueId: string; attachmentId: string | null }> => {
    const found = value(await transport.call("job-resolve-attachments", { query: RESOLVE_ATTACHMENTS, variables: { issue } }));
    if (!found?.issue?.id) throw new Error(`issue not found: ${issue}`);
    const attachment = found.issue.attachments?.nodes?.find((item: any) => item.url === url);
    return { issueId: found.issue.id, attachmentId: attachment?.id ?? null };
  };
  const before = await resolve();
  if (before.attachmentId) return { nativeId: before.attachmentId };
  const created = await transport.call("job-attachment", {
    query: CREATE_ATTACHMENT,
    variables: { issue: before.issueId, url, title },
  });
  if (created.ok) {
    const result = created.value.data as any;
    if (!result?.attachmentCreate?.success) throw new Error("attachment creation was not successful");
    return { nativeId: result.attachmentCreate.attachment?.id ?? url };
  }
  if (created.error.classification.class !== "already-satisfied" && created.error.classification.class !== "retryable") {
    throw new Error(created.error.message);
  }
  const after = await resolve();
  if (after.attachmentId) return { nativeId: after.attachmentId };
  throw new Error(created.error.message);
}

function relay(job: Job, body: JobPayload, env: NodeJS.ProcessEnv): JobOutcome {
  const task = requiredString(body.task, "task");
  const issue = requiredString(body.issue ?? job.target, "issue");
  const decisionKey = typeof body.key === "string" && body.key ? body.key : null;
  const message = `Captain replied on ${issue}. Read the authoritative thread with: linear-axi issue view ${issue}`;
  const home = resolveHome(env);
  const args = [task, ...(decisionKey ? ["--resolve-key", decisionKey] : []), message];
  const result = spawnSync(join(home, "bin", "fm-send.sh"), args, {
    env: { ...process.env, ...env, FM_HOME: home }, encoding: "utf8", timeout: 15_000,
  });
  if (result.status !== 0) throw new Error(`fm-send failed: ${(result.stderr || result.stdout || "unknown failure").trim()}`);
  return { nativeId: task };
}

function acknowledgeCore(job: Job, body: JobPayload, db: StateDatabase, env: NodeJS.ProcessEnv): JobOutcome {
  const eventId = requiredString(body.event_id ?? job.target, "event_id");
  const sourceId = requiredString(body.source_id, "source_id");
  const delivery = db.deliveryForEvent(eventId);
  if (!delivery || delivery.core_seq <= 0) throw new Error(`core delivery sequence is not available yet: ${eventId}`);
  if (delivery.handled_at) return { nativeId: `${sourceId}:${delivery.core_seq}` };
  const home = resolveHome(env);
  const firstmateRoot = env.FM_ROOT_OVERRIDE?.trim() || home;
  const result = spawnSync(join(firstmateRoot, "bin", "fm-procevent.sh"), ["handled", sourceId, String(delivery.core_seq)], {
    env: { ...process.env, ...env, FM_HOME: home }, encoding: "utf8", timeout: 15_000,
  });
  if (result.status !== 0) throw new Error(`core acknowledgement failed: ${(result.stderr || result.stdout || "unknown failure").trim()}`);
  db.raw.query("UPDATE core_deliveries SET handled_at=? WHERE event_id=?").run(nowIso(env), eventId);
  return { nativeId: `${sourceId}:${delivery.core_seq}` };
}

async function ensureWorkflowState(job: Job, body: JobPayload, transport: LinearTransport): Promise<JobOutcome> {
  const team = requiredString(body.team ?? job.target, "team");
  const name = requiredString(body.name, "name");
  const statusKey = requiredString(body.status_key, "status_key");
  const resolved = value(await transport.call("job-team-states", { query: RESOLVE_TEAM_STATES, variables: { team } }));
  if (!resolved?.team?.id) throw new Error(`team not found: ${team}`);
  const existing = resolved.team.states?.nodes?.find((item: any) => item.name === name);
  if (existing?.id) return { nativeId: existing.id };
  const type = statusKey === "backlog" ? "backlog"
    : ["done"].includes(statusKey) ? "completed"
    : ["canceled", "duplicate"].includes(statusKey) ? "canceled"
    : ["building", "validating_code", "plan_in_progress"].includes(statusKey) ? "started"
    : "unstarted";
  const colors: Record<string, string> = { backlog: "#6B7280", unstarted: "#9CA3AF", started: "#3B82F6", completed: "#10B981", canceled: "#EF4444" };
  const created = value(await transport.call("job-create-state", { query: CREATE_WORKFLOW_STATE, variables: { team: resolved.team.id, name, type, color: colors[type] } }));
  if (!created?.workflowStateCreate?.success) throw new Error(`workflow state creation was not successful: ${name}`);
  return { nativeId: created.workflowStateCreate.workflowState?.id ?? name };
}

async function setAgentLabel(job: Job, body: JobPayload, transport: LinearTransport): Promise<JobOutcome> {
  const issue = requiredString(body.issue ?? job.target, "issue");
  const label = requiredString(body.label, "label");
  const known = Array.isArray(body.known_labels) ? body.known_labels.filter((item): item is string => typeof item === "string") : [];
  const resolved = value(await transport.call("job-resolve-labels", { query: RESOLVE_LABELS, variables: { issue } }));
  if (!resolved?.issue?.id) throw new Error(`issue not found: ${issue}`);
  const available = resolved.issue.team?.labels?.nodes?.find((item: any) => item.name === label);
  if (!available?.id) throw new Error(`configured Agent label does not exist: ${label}`);
  const current = resolved.issue.labels?.nodes ?? [];
  const remove = current.filter((item: any) => known.includes(item.name) && item.name !== label).map((item: any) => item.id);
  const add = current.some((item: any) => item.name === label) ? [] : [available.id];
  if (!add.length && !remove.length) return { nativeId: available.id };
  const updated = value(await transport.call("job-update-labels", { query: UPDATE_LABELS, variables: { issue: resolved.issue.id, added: add, removed: remove } }));
  if (!updated?.issueUpdate?.success) throw new Error(`Agent label update was not successful: ${issue}`);
  return { nativeId: available.id };
}

async function ensureLabelGroup(job: Job, body: JobPayload, transport: LinearTransport): Promise<JobOutcome> {
  const name = requiredString(body.name ?? job.target, "name");
  const resolved = value(await transport.call("job-label-groups", { query: RESOLVE_LABEL_GROUP, variables: { name } }));
  const matches = (resolved?.issueLabels?.nodes ?? []).filter((item: any) => item.name === name && item.isGroup && !item.team);
  if (matches.length > 1) throw new Error(`multiple workspace label groups named ${name}`);
  if (matches[0]?.id) return { nativeId: matches[0].id };
  const created = value(await transport.call("job-create-label-group", { query: CREATE_LABEL_GROUP, variables: { name } }));
  if (!created?.issueLabelCreate?.success || !created.issueLabelCreate.issueLabel?.isGroup) {
    throw new Error(`label group creation was not successful: ${name}`);
  }
  return { nativeId: created.issueLabelCreate.issueLabel.id };
}

export async function executeJob(job: Job, options: {
  db?: StateDatabase;
  config: WorkflowConfig;
  transport: LinearTransport;
  env?: NodeJS.ProcessEnv;
}): Promise<JobOutcome> {
  const body = payload(job);
  if (body.requires_managed === true) {
    if (!options.db) throw new Error("managed issue guard requires the state database");
    if (options.db.latestSnapshot(job.target)?.managed !== true) return {};
    const resolved = value(await options.transport.call("job-resolve-managed", { query: RESOLVE_MANAGED, variables: { issue: job.target } }));
    const issue = resolved?.issue;
    const identifier = typeof issue?.identifier === "string" ? issue.identifier : job.target;
    const teamKey = identifier.slice(0, identifier.indexOf("-")).toUpperCase();
    const team = options.config.teams.find((item) => item.key === teamKey);
    const assigned = team?.managed === "all" || (typeof resolved?.viewer?.displayName === "string"
      && issue?.assignee?.displayName === resolved.viewer.displayName);
    const allowedProjects = new Set(team?.projects.map((item) => item.toLowerCase()) ?? []);
    const projectManaged = Boolean(team) && (!allowedProjects.size
      || allowedProjects.has(issue?.project?.slugId?.toLowerCase() ?? "")
      || allowedProjects.has(issue?.project?.name?.toLowerCase() ?? ""));
    if (!issue || !assigned || !projectManaged) return {};
  }
  switch (job.kind) {
    case "linear.issue-state": return updateIssueState(job, body, options.transport, options.config);
    case "linear.comment": return createComment(job, body, options.transport, options.db);
    case "linear.attachment": return createAttachment(job, body, options.transport);
    case "relay": return relay(job, body, options.env ?? process.env);
    case "core.ack": {
      if (!options.db) throw new Error("core acknowledgement requires the state database");
      return acknowledgeCore(job, body, options.db, options.env ?? process.env);
    }
    case "linear.workflow-state": return ensureWorkflowState(job, body, options.transport);
    case "linear.agent-label": return setAgentLabel(job, body, options.transport);
    case "linear.label-group": return ensureLabelGroup(job, body, options.transport);
    default: throw new Error(`unknown job kind: ${job.kind}`);
  }
}

export function nextAttempt(job: Job, env: NodeJS.ProcessEnv = process.env, retryAfterSeconds?: number): string {
  const base = Math.min(3600, 2 ** Math.min(job.attempts, 10));
  const jitter = Number.parseInt(sha256(job.id).slice(0, 4), 16) % Math.max(1, Math.ceil(base / 4));
  const delay = Math.max(base + jitter, retryAfterSeconds ?? 0);
  return new Date((nowEpoch(env) + delay) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function processJobs(options: {
  db: StateDatabase;
  config: WorkflowConfig;
  transport: LinearTransport;
  env?: NodeJS.ProcessEnv;
  maxAttempts?: number;
}): Promise<{ done: number; retried: number; dead: number }> {
  const env = options.env ?? process.env;
  const maxAttempts = options.maxAttempts ?? 8;
  let done = 0;
  let retried = 0;
  let dead = 0;
  for (const job of options.db.claimDueJobs(20, nowIso(env))) {
    try {
      const result = await executeJob(job, { db: options.db, config: options.config, transport: options.transport, env });
      options.db.transaction(() => {
        for (const followup of result.followups ?? []) options.db.enqueue(followup, nowIso(env));
        const completedAt = nowIso(env);
        if (job.kind === "linear.comment" && payload(job).actor === "core") {
          options.db.observe({
            id: `obs:${sha256(`firstmate-comment:${job.id}:${result.nativeId ?? "unknown"}`)}`,
            source: "summary", task: null, issue: job.target, verb: "firstmate-comment",
            key: result.nativeId ?? job.id, note: null, observed_at: completedAt,
          });
        }
        if (job.kind === "relay") {
          const relayPayload = payload(job);
          const eventId = requiredString(relayPayload.event_id, "event_id");
          const task = requiredString(relayPayload.task, "task");
          options.db.observe({
            id: `obs:${sha256(`relay:${job.id}:${task}`)}`,
            source: "summary", task, issue: job.target, verb: "relay",
            key: eventId, note: null, observed_at: completedAt,
          });
          options.db.setDisposition(eventId, "handled-by-service", `relayed to ${result.nativeId ?? job.target}`, completedAt);
        }
        options.db.finishJob(job.id, result.nativeId ?? null, completedAt);
      });
      done += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isDead = job.attempts >= maxAttempts || message.startsWith("precondition changed:") || message.includes("unknown job kind");
      const retryAfter = /retry-after=(\d+)/.exec(message)?.[1];
      options.db.transaction(() => {
        options.db.retryJob(job.id, message, nextAttempt(job, env, retryAfter ? Number(retryAfter) : undefined), isDead);
        if (isDead && job.kind === "relay") {
          const eventId = requiredString(payload(job).event_id, "event_id");
          options.db.setDisposition(eventId, "waiting-for-core", `relay failed: ${message}`, nowIso(env));
        }
      });
      if (isDead) dead += 1;
      else retried += 1;
    }
  }
  return { done, retried, dead };
}
