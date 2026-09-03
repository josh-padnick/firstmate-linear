import { runService, runServiceOnce } from "../service/service.ts";

export async function runServiceCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? "run";
  if (sub === "run") {
    await runService();
    return 0;
  }
  if (sub === "once") {
    try {
      const result = await runServiceOnce();
      process.stdout.write(`fm-linear service: captured=${result.captured} jobs=${result.jobsDone} retry=${result.jobsRetried} dead=${result.jobsDead} mirror=${result.mirrorActions} escalations=${result.escalations} findings=${result.findings} resumed=${result.resumed}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`fm-linear service: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  process.stderr.write("Usage: fm-linear service run|once\n");
  return 2;
}
