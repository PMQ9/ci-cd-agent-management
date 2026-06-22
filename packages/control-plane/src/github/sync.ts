import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { installations, repos, type RepoRow } from "../db/schema.js";
import { getApp } from "./app.js";

export async function upsertInstallation(input: {
  id: number;
  accountLogin: string;
  repoSelection?: string;
  suspendedAt?: Date | null;
}): Promise<void> {
  await db
    .insert(installations)
    .values({
      id: input.id,
      accountLogin: input.accountLogin,
      repoSelection: input.repoSelection ?? "selected",
      suspendedAt: input.suspendedAt ?? null,
    })
    .onConflictDoUpdate({
      target: installations.id,
      set: {
        accountLogin: input.accountLogin,
        repoSelection: input.repoSelection ?? "selected",
        suspendedAt: input.suspendedAt ?? null,
      },
    });
}

export async function upsertRepo(input: {
  githubRepoId: number;
  installationId: number;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
}): Promise<void> {
  await db
    .insert(repos)
    .values({
      githubRepoId: input.githubRepoId,
      installationId: input.installationId,
      fullName: input.fullName,
      isPrivate: input.isPrivate,
      defaultBranch: input.defaultBranch,
    })
    .onConflictDoUpdate({
      target: repos.githubRepoId,
      set: {
        installationId: input.installationId,
        fullName: input.fullName,
        isPrivate: input.isPrivate,
        defaultBranch: input.defaultBranch,
      },
    });
}

export async function removeRepoByGithubId(githubRepoId: number): Promise<void> {
  await db.delete(repos).where(eq(repos.githubRepoId, githubRepoId));
}

export async function removeInstallation(id: number): Promise<void> {
  await db.delete(installations).where(eq(installations.id, id));
}

export async function findRepoByGithubId(githubRepoId: number): Promise<RepoRow | undefined> {
  const [row] = await db.select().from(repos).where(eq(repos.githubRepoId, githubRepoId)).limit(1);
  return row;
}

/** Pull the installation's repos from GitHub and upsert them (used on connect). */
export async function syncInstallationRepos(installationId: number): Promise<number> {
  const octokit = await getApp().getInstallationOctokit(installationId);
  const { data } = await octokit.request("GET /installation/repositories", { per_page: 100 });
  for (const r of data.repositories) {
    await upsertRepo({
      githubRepoId: r.id,
      installationId,
      fullName: r.full_name,
      isPrivate: r.private,
      defaultBranch: r.default_branch ?? "main",
    });
  }
  return data.repositories.length;
}
