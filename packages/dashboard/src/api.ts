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

export const api = {
  me: () => req<{ login: string }>("/auth/me"),
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
    req<{ ok: boolean; synced: number }>(`/api/installations/${id}/sync`, { method: "POST", body: "{}" }),

  runners: () => req<RunnerDTO[]>("/api/runners"),
  revokeRunner: (id: string) =>
    req<{ ok: boolean }>(`/api/runners/${id}/revoke`, { method: "POST", body: "{}" }),

  jobs: () => req<JobDTO[]>("/api/jobs"),
  usage: () => req<UsageSummary>("/api/usage/summary"),

  pulls: () => req<PullRequestDTO[]>("/api/pulls"),
  syncPulls: () =>
    req<{ ok: boolean; open: number; repos: number; cappedRepos: number }>("/api/pulls/sync", {
      method: "POST",
      body: "{}",
    }),
};
