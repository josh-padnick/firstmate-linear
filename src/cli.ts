import { runActV6 } from "./commands/act-v6.ts";
import { runConfig } from "./commands/config.ts";
import { runContract } from "./commands/contract.ts";
import { runCutover, runInstall, runUninstall } from "./commands/install.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runInboxV6 } from "./commands/inbox-v6.ts";
import { runInit } from "./commands/init.ts";
import { runMirror } from "./commands/mirror.ts";
import { runReport } from "./commands/report.ts";
import { runReview } from "./commands/review.ts";
import { runServiceCommand } from "./commands/service.ts";
import { runStatus } from "./commands/status.ts";
import { runTask } from "./commands/task.ts";

const VERSION = "1.0.0";
const USAGE = `fm-linear - Linear as the system of record for Firstmate

Usage:
  fm-linear init --captain NAME --team KEY
  fm-linear install [--harness claude|grok|codex] [--no-bind]
  fm-linear service run|once
  fm-linear inbox list|show [EVENT]|handle EVENT --receipt RECEIPT
  fm-linear act <verb> ISSUE --receipt RECEIPT [flags]
  fm-linear report
  fm-linear mirror --plan|apply
  fm-linear task link|close|list
  fm-linear review scaffold|check
  fm-linear contract lint|apply-states --team KEY|apply-labels
  fm-linear config show --effective|import DIR
  fm-linear cutover enable|disable
  fm-linear doctor [--offline]
  fm-linear status
  fm-linear uninstall
`;

type Handler = (args: string[]) => number | Promise<number>;
const commands: Record<string, Handler> = {
  init: runInit,
  install: runInstall,
  uninstall: runUninstall,
  cutover: runCutover,
  service: runServiceCommand,
  inbox: runInboxV6,
  act: runActV6,
  report: runReport,
  mirror: runMirror,
  task: runTask,
  review: runReview,
  contract: runContract,
  config: runConfig,
  doctor: runDoctor,
  status: runStatus,
};

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "--version" || command === "-V") { process.stdout.write(`fm-linear ${VERSION}\n`); return 0; }
  if (!command || command === "--help" || command === "-h") { process.stdout.write(USAGE); return command ? 0 : 2; }
  const handler = commands[command];
  if (!handler) { process.stderr.write(`fm-linear: unknown command ${command}\n${USAGE}`); return 2; }
  return handler(args.slice(1));
}

process.exit(await main());
