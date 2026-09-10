import { mkdir } from "node:fs/promises";
import { buildIdentity } from "../src/support/build-identity";

const directory = process.argv.includes("--compile") ? "dist" : ".build";
await mkdir(directory, { recursive: true });
const child = Bun.spawn(
  [
    process.execPath,
    "build",
    "src/cli.ts",
    "--compile",
    "--define",
    `FM_LINEAR_BUILD_ID=${JSON.stringify(await buildIdentity(process.cwd()))}`,
    "--outfile",
    `${directory}/fm-linear`,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await child.exited) !== 0) process.exit(1);
