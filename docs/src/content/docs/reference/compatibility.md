---
title: Compatibility
description: Check whether your installed Firstmate checkout provides the interfaces FM Linear needs.
---

FM Linear connects through Firstmate's existing commands, task files, and process-event extension.
Because a Firstmate installation can change as its checkout follows `main`, compatibility should be checked against the code actually installed on your machine.
A previously passing revision does not establish that a newer checkout behaves the same way.

## Platforms

FM Linear targets macOS and Linux, matching the platforms listed by [Firstmate](https://github.com/kunchenguid/firstmate#readme).
Windows is not supported.

## Check your Firstmate installation

The proposed compatibility command is:

```sh
fm-linear test
```

It checks the configured Firstmate installation and reports the FM Linear version, Firstmate commit, relevant local modifications, and integration capabilities tested.
The command still needs implementation; the behavior below defines its intended contract.

Checks should exercise the command behavior and data formats FM Linear depends on, including reading task state, preparing briefs, handling external events, and the selected message and dependency interfaces.
Read-only checks inspect the installed configuration.
Behavioral checks run against an isolated copy of the relevant installed code with temporary task data and test doubles for agents and external services.
They must not launch paid agents, notify your live crew, change your projects, or write to Linear.

The result distinguishes **passed**, **failed**, and **not verified** checks.
Missing prerequisites, an unsupported backend, or a check that could not run must not be reported as a pass.
If a required capability fails or remains unverified, FM Linear explains which integration behavior is affected.

## When checks run

Every service start, including a restart, should run the applicable compatibility checks before enabling synchronization that depends on Firstmate.
The service starts its diagnostics first so it can explain a failure even if synchronization cannot begin.
Setup follows the same sequence when you choose **Save and start**.

While running, the service should detect changes to the installed Firstmate commit, relevant local files, or configuration.
An update to remote `main` matters only after the installed checkout changes; FM Linear does not fetch or update Firstmate.
The service pauses affected operations, waits for the installation to stop changing, and reruns the applicable checks.
If those checks pass, it resumes pending work.

Rechecking does not require restarting the entire service.
Independent operations and diagnostics can continue while the Firstmate adapter checks the changed installation.
Changes to FM Linear's own adapter or test suite also invalidate earlier results.
You can run `fm-linear test` manually after updating Firstmate or when investigating unexpected behavior.

Repeated checks of an unchanged, verified installation should stay quiet.
A new failure should produce a visible diagnostic, with the affected integration actions held pending while independent supported operations continue.

## What a passing result means

A pass establishes that the tested contracts behaved as expected for the recorded checkout, configuration, and environment.
It does not prove every possible path or every future agent action.
A code change during a test invalidates the result until the installed code is checked consistently.

For example, a test can confirm that prepared text is copied into a worker's launch brief.
It cannot force Firstmate to call the preparation command before every dispatch or prove that a worker follows the instructions.
The [task-brief guide](/reference/firstmate/#how-firstmate-learns-the-sequence) explains that limitation.

Isolated checks also do not prove that live Linear credentials, an external service, or a real agent conversation will work end to end.
Setup's connection checks and a small [test task](/guides/setup/#9-check-your-first-conversation) cover that separate path.
The current design still needs verification of its report-submission interface and any optional backend-specific capabilities before they can be claimed as supported.

## When a check fails

FM Linear should explain what failed, which work is paused, and what you can do next.
Pending deliveries and issue history remain saved while you resolve the problem.
FM Linear must not silently substitute another delivery mechanism or automatically change your Firstmate checkout.

### How you hear about a background failure

During setup, choose where FM Linear should report integration problems and confirm the notification policy.
The recommended policy is:

- **Create a Linear issue for a blocking failure.** Assign it to the captain with **Urgent** priority in the configured team.
  Include the failed checks, installed versions, affected operations, and suggested next steps without copying private task content or secrets.
- **Ask Firstmate to notify the captain if its messaging interface remains verified.** Include the same incident summary and Linear issue link when available.
  Do not rely on an interface that failed compatibility checks to deliver the alert.
- **Show a local desktop notification when enabled and permitted.** Keep the incident visible in `fm-linear status` and logs even if both remote routes are unavailable.

A failure of an unused optional capability does not need an Urgent issue.
Use one incident per underlying problem and update its existing issue instead of opening another on every check or restart.
Keep diagnostic issues outside normal work enrollment so they do not automatically dispatch repair work to the crew.

If Linear is unavailable, retain the pending notification and retry when the connection recovers.
When fresh checks pass, update the incident and its Linear issue to show recovery.
Avoid repeated alerts for an unchanged failure.
These notifications are part of the proposed background-service behavior; the isolated tests themselves do not contact agents or Linear.

See [Reporting bugs](/guides/troubleshooting/) for how to include the compatibility result in a report you review before submitting.
An operational issue in your workspace does not automatically file a public GitHub bug report.
