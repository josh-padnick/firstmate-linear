import { cutover, install, uninstall } from "../install/install.ts";
import { optionValues } from "./args.ts";

export function runInstall(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  let harnesses: string[];
  try { harnesses = optionValues(args, "--harness"); }
  catch (error) { process.stderr.write(`fm-linear install: ${error instanceof Error ? error.message : String(error)}\n`); return 2; }
  try {
    const result = install({ harnesses, bind: !args.includes("--no-bind"), env });
    process.stdout.write(`fm-linear install: binary=${result.binary}\nlaunch-agent=${result.plist}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`fm-linear install: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export function runUninstall(_args: string[], env: NodeJS.ProcessEnv = process.env): number {
  try {
    uninstall(env);
    process.stdout.write("fm-linear uninstall: service and harness accelerators removed; config and database preserved\n");
    return 0;
  } catch (error) {
    process.stderr.write(`fm-linear uninstall: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export function runCutover(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const mode = args[0];
  if (mode !== "enable" && mode !== "disable") {
    process.stderr.write("Usage: fm-linear cutover enable|disable\n");
    return 2;
  }
  try { cutover(mode, env); process.stdout.write(`fm-linear cutover: ${mode}d\n`); return 0; }
  catch (error) { process.stderr.write(`fm-linear cutover: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}
