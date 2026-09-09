---
title: Set up FM Linear
description: Install FM Linear, connect Firstmate and Linear, choose your workflow, and verify your first conversation.
---

First, create a dedicated Linear account for Firstmate.
Then install FM Linear on the machine where you run Firstmate and use the setup wizard to connect your Linear workspace.
At the end, ask Firstmate for a small task and reply to its update in Linear to check that the connection works in both directions.

## Before you begin

Have these ready:

- A macOS or Linux machine with a working [Firstmate installation](https://github.com/kunchenguid/firstmate) that can already dispatch crewmates.
- The location of your Firstmate home and a repository it can work on.
- A Linear workspace and the team where you want to track work.
- An email address you control for Firstmate's dedicated Linear account, separate from the address you use for your personal account.
- Permission to invite a member to your Linear workspace, or help from a workspace administrator.

:::note[A separate Linear account for Firstmate]
This setup uses two separate Linear accounts:

- **Firstmate's account** publishes automated updates and receives crew assignments.
  You will [create Firstmate's account in step 1](#1-create-a-linear-account-for-firstmate), or reuse an existing dedicated account.
- **Your personal account** is where you give feedback and receive review and approval requests.

Read [why we recommend a separate account](/reference/configuration/#why-a-dedicated-firstmate-account).

On Linear's Free plan, the additional account has no seat charge.
On a paid plan, Firstmate counts as an additional billable member of your workspace.
See [Linear's billing policy](https://linear.app/docs/billing-and-plans#billing) for how adding a member affects your subscription.
:::

### Which Linear plan do I need?

**Linear Free is enough to get started.**
The API access and issue-tracking features used by this setup are available on **Free, Basic, Business, and Enterprise**.
You do not need a paid plan solely to connect FM Linear.

Free includes unlimited members, two teams, and 250 issues.
Those workspace limits also apply to work tracked through FM Linear; choose a paid plan when you need more capacity or plan-specific features such as private teams.
See [Linear's plan comparison](https://linear.app/pricing) for current limits and features.

Your workspace must also allow Firstmate's account to create an API key and access the connected teams.
An administrator may need to enable member API keys under **Settings → Administration → API**, regardless of the plan you choose.
See [Linear's API access settings](https://linear.app/docs/api-and-webhooks).

## 1. Create a Linear account for Firstmate

Create a separate Linear user named **Firstmate** in your existing workspace.

If you already have a dedicated Firstmate account in this workspace, confirm it has access to the team you want to use, then continue to step 2.
Otherwise, follow these steps before starting the FM Linear setup wizard:

1. Choose a separate email address you control for Firstmate, such as `firstmate@your-company.com` or a Gmail alias like `your.name+firstmate@gmail.com`.
   You must be able to receive its invitation and sign-in emails.
2. Sign in to Linear with **your personal account**.
   Open **Settings → Administration → Members** and click **Invite**.
   If you cannot invite members, ask your workspace administrator to do this step.
3. Enter Firstmate's email address, select the team where it will work, and send the invitation.
4. Open the invitation in a separate browser profile or private window so you do not accept it as your personal user.
   Follow the invitation to create the account and join your existing workspace.
5. Set the new user's display name to **Firstmate** under **Settings → Account → Profile**.
6. Sign in to Linear with **Firstmate's account**.
   Confirm that you can open the team where FM Linear will track work.

Linear's [member invitation guide](https://linear.app/docs/invite-members) covers workspace-specific invitation requirements, including organizations that manage accounts through an identity provider.
Create one account for Firstmate, not a separate account for every crewmate or model.

## 2. Install FM Linear and start setup

On **macOS or Linux**, run:

```sh
curl -fsSL https://github.com/josh-padnick/fm-linear/releases/latest/download/install.sh | sh
```

Open a new terminal and check that the command is available:

```sh
fm-linear --version
```

Then start the guided setup:

```sh
fm-linear setup
```

If your terminal cannot find `fm-linear`, check that the executable's directory is on your `PATH`, then reopen the terminal.
You do not need to clone the source repository or install Bun to use a packaged executable.

## 3. Select your Firstmate installation

When the wizard asks for your **Firstmate home**, select a detected installation or enter its full path.
This is the directory containing Firstmate's configuration and task records, which may be different from the repository your crew works on.
If you do not know the path, ask Firstmate where its home is.

Confirm the detected Firstmate commit and review any integration changes before applying them.
The wizard should use the same [compatibility checks as `fm-linear test`](/reference/compatibility/#check-your-firstmate-installation) before activating the connection.
Resolve failed compatibility checks before continuing, including [whether workflow instructions can reach crewmates before dispatch](/reference/firstmate/#workflow-instructions-before-work-starts).

## 4. Connect your Linear account

Keep the wizard open while you create an API key:

1. Sign in to Linear with **Firstmate's account**.
2. Open **Security & access** in Linear's settings and create a personal API key named **FM Linear**.
3. Return to the terminal and paste the key into the wizard's masked credential prompt.
4. Confirm the workspace and account shown by the connection check.

Linear documents personal API keys in its [API authentication guide](https://linear.app/developers/graphql#personal-api-keys).
The publishing account needs access to the connected teams and permission to read and update their issues and comments.
If the connection check reports missing access, fix that access and retry before continuing.

Paste the key into the credential prompt, not into an agent conversation or a workflow file.
FM Linear stores credentials separately from your editable configuration.

## 5. Choose where to track work

Select your Linear team, then choose a default project if you use one.
Select the repository that work in this connection normally belongs to.
Start with one team and one repository; you can add more connections later.

Choose **Requests started through Firstmate** as your starting intake policy.
You will ask Firstmate for work normally, and FM Linear will create or link the corresponding issue.
Existing Backlog and ToDo issues remain untouched unless you explicitly bring them into the integration.

## 6. Choose your workflow and people

Choose one of two options:

- **Use the recommended workflow** to start with the recommended stages.
  The wizard fetches your selected team's existing Linear statuses and shows which ones it can reuse and which are missing.
- **Customize a workflow** to open the recommended YAML or an existing configuration in your editor.
  Follow the [Workflow configuration reference](/reference/workflow/) to edit stages, assignments, and instructions.

If statuses are missing, the wizard lists the proposed additions and asks:

> Would you like us to create the following Linear statuses to match the recommended workflow?

Choose **Yes, create these statuses** to create only the listed missing statuses in your selected team.
Existing statuses are preserved.
If you decline, map the stages to existing statuses or choose **Customize a workflow** instead.
If all needed statuses already exist, no creation step is necessary.

The wizard validates the final mappings and summarizes your configuration before you save.
If Firstmate's account cannot create statuses, the wizard explains the required access so you can resolve it or create the listed statuses yourself, then retry.

Assign **Firstmate's account** to crew work, then choose the people responsible for plan, deliverable, merge, and captain decisions.
For a solo setup, use **your personal account** for all human handoffs.
See the [assignment reference](/reference/workflow/#people-and-assignments) if you are setting up a team.

Review the suggested crewmate and model labels, reusing existing labels or approving new ones.
Labels identify the worker; the assignee identifies who needs to act next.

## 7. Set the crew's instructions and issue details

Optionally add [agent instructions](/reference/workflow/#instructions) to the stages where the crew performs work.
For example, add the following to `build`:

> Create an interactive HTML review guide with each implementation deliverable.
> Explain what changed, how to review it, and the verification results.

Choose an artifact location that you and the crew can access after temporary worktrees are removed.
If you use Herdr, enable the **Herdr panel name** in the issue details.
See [issue customization](/reference/configuration/#customize-linear-issue-details) for more options.

## 8. Review the changes and start syncing

The wizard presents a summary before enabling the connection.
Check the Firstmate home, Linear account, team, project, repository, status mappings, reviewers, labels, and instructions.
Review any new Linear resources or changes to the Firstmate integration separately from saving local settings.

Leave the polling interval at **30 seconds** to start.
Enable **Start at login** if you want synchronization to resume when you sign in to your computer.
Review the [background failure notifications](/reference/compatibility/#how-you-hear-about-a-background-failure), including the captain and Linear team for urgent integration issues.
Choose **Save and start** to save the configuration and start the background service.

You can close the setup terminal once the service is running.
Your machine must remain awake and connected for synchronization to continue.
No public endpoint or inbound port is required.

Check the connection from a terminal:

```sh
fm-linear status
```

Look for a running service, a connected Linear account, a successful Firstmate connection, and a recent successful sync.
If a check fails, use [Reporting bugs](/guides/troubleshooting/) before sending real work through the connection.

## 9. Check your first conversation

Ask Firstmate for a small task in the connected repository:

> Review the README and suggest one useful improvement.
> Prepare a plan for my approval before making changes.

Follow the issue link Firstmate returns.
Check that it is in the selected team and project, describes the request, and shows the appropriate status and crew label.
When the plan is ready, it should be in **Approve Plan** and assigned to you.

Reply in the plan's Linear thread:

> Before I approve this, explain who would benefit from the improvement.

Wait for Firstmate's answer in that same thread.
The next poll normally picks up your comment within the configured interval; Firstmate may need additional time to respond.

You can then approve the plan, request changes, or cancel the small test task through Firstmate.

You can rerun `fm-linear setup` to review your settings or [ask Firstmate to change your workflow](/reference/configuration/#maintain-the-workflow).

Next, [request new work](/guides/workflow/).
