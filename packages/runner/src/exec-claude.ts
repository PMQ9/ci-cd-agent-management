import { spawn } from "node:child_process";
import { type PriorFinding, type ReviewOutput, ReviewOutputSchema } from "@agentpr/shared";

export interface AgentRunResult {
  review: ReviewOutput;
  sessionId: string | null;
  modelUsed: string | null;
  totalCostUsd: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

// An empty, valid ReviewOutput — used for the no-diff / unparseable fallbacks.
export function emptyReview(verdict: ReviewOutput["verdict"], summary: string): ReviewOutput {
  return { verdict, summary, findings: [], concerns: [], suggestedFixes: [] };
}

// The Claude Code JSON wrapper reports the resolved model differently across versions:
// a top-level `model` string, or a `modelUsage` map keyed by model id. Try both; the
// control plane stamps the "Reviewed by" line from whatever we return (null → unknown).
export function extractModel(wrapper: Record<string, any>): string | null {
  if (typeof wrapper.model === "string" && wrapper.model) return wrapper.model;
  if (wrapper.modelUsage && typeof wrapper.modelUsage === "object") {
    const keys = Object.keys(wrapper.modelUsage);
    if (keys.length) return keys[0]!;
  }
  return null;
}

// Fallback instruction builder, used only if the control plane did not send an
// assembled reviewInstruction (e.g. an older control plane). The template-enforced
// prompt is assembled on the control plane; see review-prompt.ts there.
export function buildInstruction(opts: {
  repoFullName: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  round: number;
  priorFindings: PriorFinding[];
}): string {
  const lines = [
    `You are a senior code reviewer. A git diff for PR #${opts.prNumber} of ${opts.repoFullName}`,
    `(base ${opts.baseSha.slice(0, 12)} .. head ${opts.headSha.slice(0, 12)}) is provided on stdin.`,
    `Review it for correctness bugs, security issues, and clear quality/maintainability problems.`,
    `You may read files in the working directory for context (read-only).`,
  ];
  if (opts.round > 1 && opts.priorFindings.length) {
    lines.push(
      ``,
      `This is RE-REVIEW round ${opts.round}. The previous round raised these findings:`,
      JSON.stringify(opts.priorFindings, null, 2),
      `For each prior finding, decide if it is now resolved. Only re-report findings that are still open,`,
      `and ADD any new regressions introduced since the last round.`,
    );
  }
  lines.push(
    ``,
    `Respond with ONLY a JSON object (no markdown fences, no prose) of this exact shape:`,
    `{"verdict":"approve|request_changes|comment","summary":"1-3 sentences","findings":[`,
    `{"path":"repo/relative/path","line":<integer or null>,"severity":"critical|high|medium|low|info","title":"short","body":"explanation + suggested fix"}]}`,
    `Use "approve" only if there are no findings. Use "request_changes" if any finding is high or critical.`,
  );
  return lines.join("\n");
}

// The valid characters that may follow a backslash in a JSON string.
const VALID_JSON_ESCAPE = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

// Models routinely emit code snippets inside the `body` strings and "escape" their
// backticks as `\`` — which is an INVALID JSON escape, so JSON.parse throws "Bad
// escaped character" and we lose the whole structured review to the comment fallback.
// Drop any backslash that doesn't begin a valid JSON escape (so `\`` → `` ` ``) while
// leaving real escapes (`\\`, `\n`, `\uXXXX`, …) intact. Best-effort: only used after a
// strict JSON.parse has already failed.
export function repairInvalidEscapes(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      const next = s[i + 1];
      if (next === undefined) {
        out += ch; // trailing lone backslash — leave it for JSON.parse to reject
      } else if (VALID_JSON_ESCAPE.has(next)) {
        out += ch + next; // valid escape — keep the pair, skip the escaped char
        i++;
      }
      // else: stray backslash before an invalid escape char → drop it, keep `next`
      // (it gets copied on the next iteration since i is not advanced).
    } else {
      out += ch;
    }
  }
  return out;
}

export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("no JSON object found");
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    // Retry once after repairing invalid backslash escapes (the common model mistake
    // of escaping backticks/other chars inside code-bearing string values).
    return JSON.parse(repairInvalidEscapes(slice));
  }
}

export function parseClaudeWrapper(stdout: string): AgentRunResult {
  let wrapper: Record<string, any>;
  try {
    wrapper = JSON.parse(stdout);
  } catch {
    // Not JSON at all — treat the whole stdout as a plain comment.
    return {
      review: emptyReview("comment", stdout.slice(0, 4000) || "(empty agent output)"),
      sessionId: null,
      modelUsed: null,
      totalCostUsd: 0,
      inputTokens: null,
      outputTokens: null,
    };
  }

  const resultText: string = typeof wrapper.result === "string" ? wrapper.result : "";
  const usage = wrapper.usage ?? {};
  const base = {
    sessionId: typeof wrapper.session_id === "string" ? wrapper.session_id : null,
    modelUsed: extractModel(wrapper),
    totalCostUsd: typeof wrapper.total_cost_usd === "number" ? wrapper.total_cost_usd : 0,
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
  };

  // The agent's final text should itself be our ReviewOutput JSON.
  try {
    const parsed = ReviewOutputSchema.safeParse(extractJsonObject(resultText));
    if (parsed.success) return { review: parsed.data, ...base };
  } catch {
    /* fall through to comment fallback */
  }
  return {
    review: emptyReview("comment", resultText.slice(0, 4000) || "(no structured output)"),
    ...base,
  };
}

function spawnCollect(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`agent timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`agent exited ${code}: ${stderr.slice(0, 2000)}`));
    });

    child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

export async function runClaudeReview(opts: {
  claudeBin: string;
  cwd: string;
  diff: string;
  repoFullName: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  round: number;
  priorFindings: PriorFinding[];
  resumeSessionId: string | null;
  model: string | null;
  // The template-enforced instruction assembled by the control plane. When absent
  // (older control plane), fall back to the local builder.
  reviewInstruction?: string | null;
  timeoutMs: number;
}): Promise<AgentRunResult> {
  // The load-bearing guard: a stray API key silently bills pay-per-token.
  if (process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is set — refusing to run; this would bill the API instead of your Claude subscription. Unset it in the runner environment.",
    );
  }

  const args = [
    "-p",
    opts.reviewInstruction || buildInstruction(opts),
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    "Read,Grep,Glob",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;

  if (!opts.diff.trim()) {
    return {
      review: emptyReview("comment", "No diff between base and head — nothing to review."),
      sessionId: null,
      modelUsed: null,
      totalCostUsd: 0,
      inputTokens: null,
      outputTokens: null,
    };
  }

  const stdout = await spawnCollect(opts.claudeBin, args, {
    cwd: opts.cwd,
    env: childEnv,
    stdin: opts.diff.slice(0, 9_500_000), // stay under the ~10MB stdin cap
    timeoutMs: opts.timeoutMs,
  });
  return parseClaudeWrapper(stdout);
}
