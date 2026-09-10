import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pollRequest } from "../src/firstmate/messages";
import { AdapterStore } from "../src/firstmate/store";
import { Diagnostic } from "../src/support/logging";

test("CLI schema failures preserve clean stdout and do not leak payload canaries", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fm-cli-")));
  try {
    await mkdir(join(root, "code/bin"), { recursive: true });
    await mkdir(join(root, "home"));
    await writeFile(join(root, "input.json"), '{"PRIVATE_COMMENT_CANARY":"secret"}');
    const child = Bun.spawn(
      [
        process.execPath,
        "src/cli.ts",
        "receive",
        "--home",
        join(root, "home"),
        "--code-root",
        join(root, "code"),
        "--state",
        join(root, "private/state.sqlite"),
        "--input",
        join(root, "input.json"),
        "--json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).not.toContain("PRIVATE_COMMENT_CANARY");
    expect(Diagnostic.parse(JSON.parse(stderr)).error.code).toBe("config.invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("a process killed immediately after durable acceptance retains the exact request", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fm-crash-")));
  try {
    await mkdir(join(root, "home"));
    const database = join(root, "private/state.sqlite");
    const modulePath = JSON.stringify(resolve("src/firstmate/messages.ts"));
    const storePath = JSON.stringify(resolve("src/firstmate/store.ts"));
    const childFile = join(root, "crash.ts");
    await writeFile(
      childFile,
      `import {sendMessage} from ${modulePath};import {AdapterStore} from ${storePath};const store=new AdapterStore(process.argv[2]);await sendMessage({homeId:'home',home:process.argv[3],codeRoot:process.argv[3]},store,{requestId:'durable',destination:{kind:'home',homeId:'home'},text:'Survive the crash',context:'',expectedResponse:'text'},async()=>{process.kill(process.pid,'SIGKILL');await new Promise(()=>{});});`,
    );
    const child = Bun.spawn([process.execPath, childFile, database, join(root, "home")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).not.toBe(0);
    const store = new AdapterStore(database, { existing: true });
    try {
      const record = JSON.parse(pollRequest(store, "home", "durable", "host-1").output);
      expect(record.text).toBe("Survive the crash");
      expect(record.requestId).toBe("durable");
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
