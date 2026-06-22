import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

for (const p of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
  if (existsSync(p)) {
    try {
      (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(p);
    } catch {
      /* rely on real env */
    }
  }
}

const EnvSchema = z.object({
  CONTROL_PLANE_URL: z.string().url().default("http://localhost:8080"),
  RUNNER_NAME: z.string().default("runner"),
  RUNNER_ENROLLMENT_SECRET_CLIENT: z.string().optional(),
  // Absolute path to the claude binary (NOT on the non-interactive PATH on your self-hosted host).
  CLAUDE_BIN: z.string().default("claude"),
  OPENCODE_BIN: z.string().default("opencode"),
  RUNNER_WORKDIR: z.string().default(resolve(homedir(), ".agentpr/work")),
  // Where the durable runner token is persisted after enrollment.
  RUNNER_CRED_FILE: z.string().default(resolve(homedir(), ".agentpr/runner.json")),
  POLL_TIMEOUT_MS: z.coerce.number().default(60_000),
  CLAUDE_TIMEOUT_MS: z.coerce.number().default(20 * 60_000),
});

export type Env = z.infer<typeof EnvSchema>;
export const env: Env = EnvSchema.parse(process.env);
