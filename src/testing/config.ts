import { parseConfig } from "../../src/config/load.ts";
import type { FeatureMode, ManagedScope, WorkflowConfig, WorkflowRole } from "../../src/config/schema.ts";

export const FULL_ROLES: Record<WorkflowRole, string> = {
  plan: "Plan In Progress",
  "plan-gate": "Approve Plan",
  waiting: "Waiting",
  building: "Building",
  "review-gate": "Approve Deliverable",
  validating: "Validating Code",
  "merge-gate": "Approve Merge",
  "decision-captain": "Needs Decision",
  "decision-firstmate": "Needs Firstmate Decision",
  done: "Done",
  canceled: "Canceled",
};

export function testWorkflowConfig(options: {
  key?: string;
  managed?: ManagedScope;
  roles?: Partial<Record<WorkflowRole, string>>;
  features?: Partial<Record<"relay" | "mirror" | "escalation", FeatureMode>>;
  agentLabels?: Record<string, string>;
  validationMode?: "word" | "verdict";
} = {}): WorkflowConfig {
  return parseConfig({
    version: 1,
    captain: { display_name: "Captain" },
    teams: [{
      key: options.key ?? "ABC",
      projects: [],
      managed: options.managed ?? "all",
      roles: options.roles ?? FULL_ROLES,
      agent_labels: options.agentLabels ?? {},
    }],
    features: {
      relay: options.features?.relay ?? "off",
      mirror: options.features?.mirror ?? "off",
      escalation: options.features?.escalation ?? "off",
    },
    validation: { mode: options.validationMode ?? "word" },
    templates: { reply: "reply.md", report: "report.md", review_walkthrough: "review.html" },
  }, "/private/tmp/fm-linear-test/config.yaml");
}
