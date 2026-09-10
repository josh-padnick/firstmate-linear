#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { FirstmateAdapter } from "./firstmate/adapter";
import { extensionResponse } from "./firstmate/extension";
import { createExtensionPackage } from "./firstmate/extension-package";
import {
  AttemptRef,
  BriefUpdate,
  Capability,
  MessageToFirstmateSchema,
  TaskId,
} from "./firstmate/types";
import { FmError, normalizeError } from "./support/errors";
import { hash, readBounded } from "./support/files";
import { boundedStdin } from "./support/input";
import { logFailure } from "./support/logging";

async function main() {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      home: { type: "string" },
      "code-root": { type: "string" },
      state: { type: "string" },
      json: { type: "boolean" },
      input: { type: "string" },
      receipt: { type: "string" },
      capability: { type: "string", multiple: true },
      executable: { type: "string" },
      "message-id": { type: "string" },
    },
  });
  const command = positionals[0];
  if (!command || command === "help") {
    console.log(
      "fm-linear <installation|test|task|brief-update|brief-check|send|receive|respond|extension-package> --home PATH --code-root PATH --state DATABASE [--json]\nPayload commands read --input FILE. brief-check also takes --receipt FILE. respond REQUEST_ID reads a content object and accepts --message-id for distinct follow-ups. extension-package DIRECTORY accepts --executable PATH. test accepts repeated --capability task-state|briefs|messages.",
    );
    return;
  }
  if (command === "extension") {
    process.stdout.write(
      JSON.stringify(extensionResponse(positionals[1] ?? "", JSON.parse(await boundedStdin()))),
    );
    return;
  }
  if (command === "extension-package") {
    if (!positionals[1]) throw new FmError("config.invalid", "Supply the new package directory.");
    const runtime = values.executable ?? process.execPath;
    if (!runtime)
      throw new FmError("config.invalid", "Supply --executable with the compiled FM Linear path.");
    console.log(JSON.stringify(await createExtensionPackage(resolve(positionals[1]), runtime)));
    return;
  }
  if (!values.home || !values["code-root"] || !values.state)
    throw new FmError(
      "config.invalid",
      "Supply --home, --code-root, and --state explicitly for this adapter milestone.",
    );
  const adapter = await FirstmateAdapter.open({
    home: values.home,
    codeRoot: values["code-root"],
    database: resolve(values.state),
  });
  try {
    const payload = async () => {
      if (!values.input)
        throw new FmError("config.invalid", "Supply --input with the JSON payload file.");
      return JSON.parse(await readBounded(values.input, 65536));
    };
    let result: unknown;
    switch (command) {
      case "installation":
        result = adapter.installation;
        break;
      case "test": {
        const report = await adapter.testFirstmateInstallation(
          values.capability?.map((c) => Capability.parse(c)),
        );
        result = report;
        process.exitCode = report.capabilities.some((c) => c.status !== "passed") ? 1 : 0;
        break;
      }
      case "task":
        result = await adapter.getFirstmateTask({
          homeId: adapter.installation.homeId,
          taskId: TaskId.parse(positionals[1]),
        });
        break;
      case "brief-update":
        result = await adapter.updateFirstmateBrief(BriefUpdate.parse(await payload()));
        break;
      case "brief-check":
        if (!values.receipt) throw new FmError("config.invalid", "Supply --receipt.");
        result = await adapter.checkFirstmateBrief(
          JSON.parse(await readBounded(values.receipt, 65536)),
          AttemptRef.parse(await payload()),
        );
        break;
      case "send":
        result = await adapter.sendFirstmateMessage(
          MessageToFirstmateSchema.parse(await payload()),
        );
        break;
      case "respond": {
        const content = await payload();
        result = await adapter.receiveFirstmateMessage({
          kind: "reply",
          requestId: positionals[1],
          messageId:
            values["message-id"] ??
            `reply-${hash(JSON.stringify([positionals[1], content])).slice(0, 32)}`,
          content,
        });
        break;
      }
      case "receive":
        result = await adapter.receiveFirstmateMessage(await payload());
        break;
      default:
        throw new FmError("config.invalid", "Unknown adapter command.");
    }
    console.log(JSON.stringify(result, null, values.json ? undefined : 2));
  } finally {
    adapter.close();
  }
}
await main().catch((error) => {
  const normalized = normalizeError(error);
  logFailure(normalized);
  process.exitCode = 2;
});
