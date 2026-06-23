import {
  type EnrollRequest,
  type EnrollResponse,
  EnrollResponseSchema,
  type JobError,
  type JobResult,
  type LeaseResponse,
  LeaseResponseSchema,
} from "@agentpr/shared";
import { env } from "./config.js";

export class ControlPlaneClient {
  private token: string | undefined;

  constructor(
    private readonly baseUrl: string,
    token?: string,
  ) {
    this.token = token;
  }

  setToken(token: string): void {
    this.token = token;
  }

  async enroll(req: EnrollRequest): Promise<EnrollResponse> {
    const res = await this.post("/api/runners/enroll", req, false);
    return EnrollResponseSchema.parse(await res.json());
  }

  /** Long-poll for the next job. Resolves to { job: null } when idle. */
  async lease(): Promise<LeaseResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), env.POLL_TIMEOUT_MS);
    try {
      const res = await this.post("/api/runners/lease", {}, true, ctrl.signal);
      return LeaseResponseSchema.parse(await res.json());
    } finally {
      clearTimeout(timer);
    }
  }

  async reportResult(result: JobResult): Promise<void> {
    await this.post("/api/runners/result", result, true);
  }

  async reportError(err: JobError): Promise<void> {
    await this.post("/api/runners/error", err, true);
  }

  private async post(
    path: string,
    body: unknown,
    auth: boolean,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth && this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(this.baseUrl + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`POST ${path} -> ${res.status} ${text}`);
    }
    return res;
  }
}
