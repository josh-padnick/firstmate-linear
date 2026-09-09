export interface WorkflowFlow {
  caption: string;
  nodes: { name: string; detail: string }[];
  steps: { title: string; text: string; active: number[]; links: number[]; reverse?: boolean }[];
}

const nodes = [
  { name: 'You', detail: 'Describe the outcome' },
  { name: 'Firstmate', detail: 'Record and organize work' },
  { name: 'FM Linear', detail: 'Read, link, and sync' },
  { name: 'Linear', detail: 'Track the issue' },
];
const steps = [
  { title: 'You ask Firstmate', text: 'Describe the work in your usual Firstmate conversation. No separate Linear request is needed.', active: [0, 1], links: [0] },
  { title: 'Firstmate records the work', text: 'Firstmate keeps the request and its context in its task records, including the task brief. It still owns planning and delegation.', active: [1], links: [] },
  { title: 'FM Linear reads the task', text: 'The adapter reads the recorded work. FM Linear checks the tracking choice, matches any existing issue, and saves a pending publication.', active: [1, 2], links: [1] },
  { title: 'The issue appears in Linear', text: 'FM Linear creates or updates the issue through the Linear API and saves the confirmed issue ID alongside the Firstmate task identity.', active: [2, 3], links: [2] },
  { title: 'The issue link comes back', text: 'The confirmed link returns through FM Linear to Firstmate, which shares it in your conversation. Future updates use the same connection.', active: [0, 1, 2, 3], links: [0, 1, 2], reverse: true },
];

export const requestFlow: WorkflowFlow = { caption: "From a conversation to a tracked issue", nodes, steps };

const incomingNodes = [
  { name: 'You', detail: 'Reply on the issue' },
  { name: 'Linear', detail: 'Keep the conversation' },
  { name: 'FM Linear', detail: 'Retrieve and deliver' },
  { name: 'Firstmate', detail: 'Interpret and coordinate' },
];

export const feedbackFlow: WorkflowFlow = {
  caption: 'From a Linear comment to a crew response',
  nodes: incomingNodes,
  steps: [
    { title: 'You reply in Linear', text: 'Write your feedback in the existing issue thread. Include links or screenshots that make the request clear.', active: [0, 1], links: [0] },
    { title: 'FM Linear retrieves the comment', text: 'On its next poll, FM Linear saves the comment, its author, and the thread context. The default polling interval is 30 seconds.', active: [1, 2], links: [1] },
    { title: 'Firstmate receives the context', text: 'FM Linear matches the issue to its Firstmate task and delivers the feedback. Firstmate decides how to respond or update the crew’s assignment.', active: [2, 3], links: [2] },
    { title: 'The reply returns to the same thread', text: 'FM Linear publishes Firstmate’s response in the original Linear thread. Acknowledging feedback does not mean the requested change is complete.', active: [1, 2, 3], links: [1, 2], reverse: true },
    { title: 'You review the follow-up', text: 'Read the response and any revised work on the issue. Continue the same conversation until the feedback has been addressed.', active: [0, 1], links: [0], reverse: true },
  ],
};

export const planFlow: WorkflowFlow = {
  caption: 'From plan approval to implementation',
  nodes: incomingNodes,
  steps: [
    { title: 'You approve a specific plan', text: 'Reply in the review thread with the plan version you approve and the scope you are authorizing for implementation.', active: [0, 1], links: [0] },
    { title: 'FM Linear retrieves the decision', text: 'The next poll captures the comment, its author, and the plan reference, then matches them to the connected task.', active: [1, 2], links: [1] },
    { title: 'Firstmate interprets the decision', text: 'Firstmate interprets the comment. FM Linear checks reviewer authority and the applicable plan version. Ambiguity calls for clarification.', active: [2, 3], links: [2] },
    { title: 'Firstmate starts the authorized work', text: 'Firstmate schedules implementation with the applicable workflow instructions. Approval grants permission; it does not prove a worker has started.', active: [3], links: [] },
    { title: 'Linear reflects implementation', text: 'When implementation is observed to start, FM Linear sets the issue to Building and assigns Firstmate. The plan and its approval remain accessible.', active: [1, 2, 3], links: [1, 2], reverse: true },
  ],
};

export const deliverableFlow: WorkflowFlow = {
  caption: 'From an accepted deliverable to validation',
  nodes: incomingNodes,
  steps: [
    { title: 'You accept the reviewed result', text: 'Reply in the deliverable’s review thread, identify its version, and authorize validation. Ask for revisions instead if the result needs changes.', active: [0, 1], links: [0] },
    { title: 'FM Linear captures the review', text: 'The next poll saves your comment and its context, including the deliverable reference and your Linear account identity.', active: [1, 2], links: [1] },
    { title: 'Firstmate receives the decision', text: 'Firstmate interprets the response, while FM Linear checks approval authority and the reviewed version. Acceptance of the deliverable does not authorize a merge.', active: [2, 3], links: [2] },
    { title: 'Firstmate coordinates validation', text: 'Firstmate arranges the configured validation work. Optional validation instructions accompany any new validation assignment.', active: [3], links: [] },
    { title: 'Linear shows validation progress', text: 'When validation starts, FM Linear updates the status and assignee. Reported findings and supporting links are published to the same issue.', active: [1, 2, 3], links: [1, 2], reverse: true },
  ],
};

export const mergeFlow: WorkflowFlow = {
  caption: 'From merge approval to confirmed delivery',
  nodes: incomingNodes,
  steps: [
    { title: 'You authorize the reviewed PR', text: 'Reply in the merge-review thread with the PR, reviewed revision, target branch, and requirement that the checks pass.', active: [0, 1], links: [0] },
    { title: 'FM Linear retrieves the approval', text: 'The next poll saves the decision and matches it to the issue, PR, and reviewed revision.', active: [1, 2], links: [1] },
    { title: 'Firstmate receives scoped permission', text: 'After the decision is interpreted and its authority and revision checked, Firstmate receives permission to merge that PR subject to the required checks.', active: [2, 3], links: [2] },
    { title: 'Firstmate coordinates the merge', text: 'Firstmate uses its repository tools and permissions to merge. Changed revisions, failing checks, or branch protections can prevent the action.', active: [3], links: [] },
    { title: 'Linear reflects confirmed delivery', text: 'FM Linear updates the issue to Done only after its configured evidence source confirms the merge and any other delivery conditions. Approval alone is insufficient.', active: [1, 2, 3], links: [1, 2], reverse: true },
  ],
};

export const progressFlow: WorkflowFlow = {
  caption: 'From crew activity to your Linear view',
  nodes: [
    { name: 'Firstmate', detail: 'Supervise the crew' },
    { name: 'FM Linear', detail: 'Observe and synchronize' },
    { name: 'Linear', detail: 'Keep the issue current' },
    { name: 'You', detail: 'See what needs attention' },
  ],
  steps: [
    { title: 'Firstmate records progress', text: 'Firstmate maintains task information and receives crew reports. A report can describe completed work, an open question, or a review handoff.', active: [0], links: [] },
    { title: 'FM Linear observes the update', text: 'The adapter reads available task evidence or receives a necessary report. FM Linear determines which configured fields and comments need updating.', active: [0, 1], links: [0] },
    { title: 'Linear receives the changes', text: 'FM Linear publishes the update, status, assignee, and managed labels. Explicit task dependencies map to blocks and blocked-by relationships between connected issues.', active: [1, 2], links: [1] },
    { title: 'You see the next action', text: 'Open your Linear view to see progress and review requests. Open an issue for its discussion, plan, PR, and supporting materials.', active: [2, 3], links: [2] },
    { title: 'FM Linear checks for missed changes', text: 'Periodic reconciliation compares the intended fields with Linear and repairs missed or incomplete updates. Pending delivery and stale information remain distinguishable from confirmed progress.', active: [1, 2], links: [1] },
  ],
};

export const configurationFlow: WorkflowFlow = {
  caption: 'From a workflow preference to saved configuration',
  nodes: [
    { name: 'You', detail: 'Describe the change' },
    { name: 'Firstmate', detail: 'Prepare the change' },
    { name: 'FM Linear', detail: 'Validate and save' },
    { name: 'Your workflow', detail: 'Use the saved rules' },
  ],
  steps: [
    { title: 'You request a workflow change', text: 'Tell Firstmate what should change, such as who reviews plans or which extra instructions accompany building work.', active: [0, 1], links: [0] },
    { title: 'Firstmate prepares a configuration change', text: 'Firstmate translates the request into a proposed change through supported FM Linear operations. You can also edit the configuration file directly.', active: [1, 2], links: [1] },
    { title: 'FM Linear validates the proposal', text: 'FM Linear checks the configuration and shows any managed Linear resource changes for review. Invalid configuration leaves the last valid settings active.', active: [2], links: [] },
    { title: 'The accepted configuration is saved', text: 'The workflow is stored in your configuration file so the change survives this conversation. Existing delivery records and issue history are preserved.', active: [2, 3], links: [2] },
    { title: 'Future work uses the updated rules', text: 'FM Linear applies the saved mappings and supplies applicable instructions during brief preparation. Changing an active assignment requires an explicit update.', active: [3], links: [] },
  ],
};
