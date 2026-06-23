// Thin typed client. Always same-origin (dev uses Vite's proxy), credentials
// included so the signed session cookie rides along.

export interface RepoDTO {
  id: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
  autoReviewEnabled: boolean;
  provider: "claude_code" | "opencode";
  model: string | null;
  dailyCostCapUsd: number | null;
}

export interface RunnerDTO {
  id: string;
  name: string;
  capabilities: { providers: string[]; version?: string };
  lastSeenAt: string | null;
  revokedAt: string | null;
  status: "online" | "offline";
}

export interface JobDTO {
  id: string;
  repoFullName: string;
  prNumber: number;
  state: string;
  trigger: string;
  round: number;
  headSha: string;
  leasedByRunner: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestDTO {
  id: string;
  repoId: string;
  repoFullName: string;
  number: number;
  title: string;
  author: string | null;
  isDraft: boolean;
  htmlUrl: string;
  autoReviewEnabled: boolean;
  prUpdatedAt: string | null;
  // Latest review job for this PR (null when never reviewed). State is a JOB_STATES value.
  jobId: string | null;
  jobState: string | null;
  jobRound: number | null;
  jobTrigger: string | null;
  jobErrorMessage: string | null;
  jobUpdatedAt: string | null;
}

export interface UsageSummary {
  today: number;
  last7d: number;
  last30d: number;
  totalRuns: number;
  totalCost: number;
  note: string;
  claudeConsoleUrl: string;
}

export interface TemplateDTO {
  id: string;
  slug: string;
  name: string;
  kind: "pr_review" | "pull_request" | "security_review";
  description: string;
  content: string;
  isActive: boolean;
  updatedAt: string;
}

export interface AgentPromptDTO {
  key: string;
  label: string;
  description: string;
  content: string;
  editable: boolean;
  updatedAt: string | null;
}

export interface VendorIncidentDTO {
  name: string;
  impact: string;
  status: string;
  shortlink?: string;
  updatedAt: string | null;
}

export type VendorLevel =
  | "operational"
  | "degraded"
  | "partial_outage"
  | "major_outage"
  | "maintenance"
  | "unknown";

export interface VendorStatusDTO {
  key: string;
  name: string;
  statusPageUrl: string;
  level: VendorLevel;
  description: string;
  indicator: string | null;
  updatedAt: string | null;
  incidents: VendorIncidentDTO[];
  ok: boolean;
}

export interface VendorStatusResponse {
  fetchedAt: string;
  vendors: VendorStatusDTO[];
}

export interface InstallationsResponse {
  installations: { id: number; accountLogin: string; repoSelection: string }[];
  installUrl: string | null;
  githubConfigured: boolean;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (res.status === 401 || res.status === 403) throw new AuthError();
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export class AuthError extends Error {
  constructor() {
    super("unauthenticated");
  }
}

export interface AuthConfig {
  githubConfigured: boolean;
  devLoginAvailable: boolean;
}

export const api = {
  me: () => req<{ login: string }>("/auth/me"),
  authConfig: () => req<AuthConfig>("/auth/config"),
  devLogin: () => req<{ ok: boolean }>("/auth/dev-login", { method: "POST", body: "{}" }),
  logout: () => req<{ ok: boolean }>("/auth/logout", { method: "POST", body: "{}" }),

  repos: () => req<RepoDTO[]>("/api/repos"),
  updateRepo: (id: string, patch: Partial<RepoDTO>) =>
    req<{ ok: boolean }>(`/api/repos/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  reviewPr: (id: string, prNumber: number) =>
    req<{ status: string; reason?: string }>(`/api/repos/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ prNumber }),
    }),

  installations: () => req<InstallationsResponse>("/api/installations"),
  syncInstallation: (id: number) =>
    req<{ ok: boolean; synced: number }>(`/api/installations/${id}/sync`, {
      method: "POST",
      body: "{}",
    }),

  runners: () => req<RunnerDTO[]>("/api/runners"),
  revokeRunner: (id: string) =>
    req<{ ok: boolean }>(`/api/runners/${id}/revoke`, { method: "POST", body: "{}" }),

  jobs: () => req<JobDTO[]>("/api/jobs"),
  usage: () => req<UsageSummary>("/api/usage/summary"),
  vendorStatus: () => req<VendorStatusResponse>("/api/vendor-status"),

  pulls: () => req<PullRequestDTO[]>("/api/pulls"),
  syncPulls: () =>
    req<{ ok: boolean; open: number; repos: number; cappedRepos: number }>("/api/pulls/sync", {
      method: "POST",
      body: "{}",
    }),

  templates: () => req<TemplateDTO[]>("/api/templates"),
  updateTemplate: (
    id: string,
    patch: Partial<Pick<TemplateDTO, "content" | "description" | "isActive">>,
  ) =>
    req<{ ok: boolean }>(`/api/templates/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  prompts: () => req<AgentPromptDTO[]>("/api/prompts"),
  updatePrompt: (key: string, content: string) =>
    req<{ ok: boolean }>(`/api/prompts/${encodeURIComponent(key)}`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    }),
  promptPreview: () => req<{ instruction: string; templateName: string }>("/api/prompts/preview"),
};
