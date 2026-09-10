import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
export async function buildIdentity(root: string): Promise<string> {
  const digest = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        digest.update(path);
        digest.update(await readFile(join(root, path)));
      }
    }
  };
  await visit("src");
  for (const path of ["package.json", "bun.lock", "scripts/build.ts"]) {
    digest.update(path);
    digest.update(await readFile(join(root, path)));
  }
  return digest.digest("hex");
}
