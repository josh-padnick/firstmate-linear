import { constants } from "node:fs";
import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EXTENSION_ADAPTER, EXTENSION_ID, EXTENSION_VERSION } from "./messages";

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
/** The immutable package delegates to the explicitly selected, installed FM Linear executable. */
export async function createExtensionPackage(destination: string, executable: string) {
  const runtime = await realpath(executable);
  await access(runtime, constants.X_OK);
  await mkdir(destination, { mode: 0o700 });
  await writeFile(
    join(destination, "firstmate-extension.json"),
    JSON.stringify({
      schema: "firstmate.extension-manifest.v1",
      id: EXTENSION_ID,
      version: EXTENSION_VERSION,
      host_protocols: [1],
      entrypoint: "entrypoint",
      capabilities: [
        { name: "process-event-adapter", versions: [1], adapter_names: [EXTENSION_ADAPTER] },
      ],
      required_consents: [],
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(destination, "entrypoint"),
    `#!/bin/sh\nexec ${shellQuote(runtime)} extension "$@"\n`,
    { mode: 0o700 },
  );
  return {
    packageRoot: await realpath(destination),
    extensionId: EXTENSION_ID,
    executable: runtime,
  };
}
