import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface RunnerCreds {
  runnerId: string;
  runnerToken: string;
}

export async function loadCreds(file: string): Promise<RunnerCreds | null> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.runnerId && parsed?.runnerToken) return parsed as RunnerCreds;
    return null;
  } catch {
    return null;
  }
}

export async function saveCreds(file: string, creds: RunnerCreds): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
}
