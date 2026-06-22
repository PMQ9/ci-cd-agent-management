import { useCallback, useEffect, useState } from "react";
import {
  AuthError,
  api,
  type InstallationsResponse,
  type JobDTO,
  type PullRequestDTO,
  type RepoDTO,
  type RunnerDTO,
  type UsageSummary,
} from "./api.js";

type Tab = "repos" | "pulls" | "runners" | "activity" | "usage";
const TAB_LABELS: Record<Tab, string> = {
  repos: "Repos",
  pulls: "Pull Requests",
  runners: "Runners",
  activity: "Activity",
  usage: "Usage",
};

export function App() {
  const [login, setLogin] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [tab, setTab] = useState<Tab>("repos");

  useEffect(() => {
    api
      .me()
      .then((r) => setLogin(r.login))
      .catch(() => setLogin(null))
      .finally(() => setAuthChecked(true));
  }, []);

  if (!authChecked) return <div className="center muted">Loading…</div>;
  if (!login) return <LoginScreen />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◆</span> Agent PR <span className="muted">Control Center</span>
        </div>
        <nav className="tabs">
          {(["repos", "pulls", "runners", "activity", "usage"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
        <div className="user">
          <span className="muted">@{login}</span>
          <button className="link" onClick={() => api.logout().then(() => location.reload())}>
            sign out
          </button>
        </div>
      </header>
      <main className="content">
        {tab === "repos" && <ReposPanel />}
        {tab === "pulls" && <PullsPanel />}
        {tab === "runners" && <RunnersPanel />}
        {tab === "activity" && <ActivityPanel />}
        {tab === "usage" && <UsagePanel />}
      </main>
    </div>
  );
}

function LoginScreen() {
  const dev = import.meta.env.DEV;
  return (
    <div className="center">
      <div className="card login">
        <div className="brand big">
          <span className="logo">◆</span> Agent PR Control Center
        </div>
        <p className="muted">Sign in to manage your repos, runners, and reviews.</p>
        <a className="btn primary" href="/auth/login">
          Sign in with GitHub
        </a>
        {dev && (
          <button className="btn ghost" onClick={() => api.devLogin().then(() => location.reload())}>
            Dev login (local only)
          </button>
        )}
      </div>
    </div>
  );
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    fn()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (e instanceof AuthError) location.reload();
        else setError(e.message);
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, loading, reload };
}

function ReposPanel() {
  const { data: repos, reload } = useAsync<RepoDTO[]>(() => api.repos(), []);
  const { data: inst, reload: reloadInst } = useAsync<InstallationsResponse>(
    () => api.installations(),
    [],
  );

  return (
    <section>
      <div className="row between">
        <h2>Repositories</h2>
        <button className="btn ghost" onClick={reload}>
          ⟳ Refresh
        </button>
      </div>

      <div className="card subtle connect">
        {inst?.githubConfigured ? (
          <>
            <span>Connect or disconnect repos on GitHub, then sync.</span>
            <div className="row gap">
              {inst.installUrl && (
                <a className="btn small" href={inst.installUrl} target="_blank" rel="noreferrer">
                  Manage on GitHub ↗
                </a>
              )}
              {inst.installations.map((i) => (
                <button key={i.id} className="btn small ghost" onClick={() => api.syncInstallation(i.id).then(reload)}>
                  Sync {i.accountLogin}
                </button>
              ))}
            </div>
          </>
        ) : (
          <span className="warn">GitHub App not configured yet — set the GITHUB_* env vars.</span>
        )}
      </div>

      {!repos?.length && <p className="muted">No repositories connected yet.</p>}
      <div className="list">
        {repos?.map((r) => (
          <RepoRow key={r.id} repo={r} onChange={reload} />
        ))}
      </div>
      <button className="link" onClick={reloadInst} hidden />
    </section>
  );
}

function RepoRow({ repo, onChange }: { repo: RepoDTO; onChange: () => void }) {
  const [pr, setPr] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const patch = (p: Partial<RepoDTO>) => api.updateRepo(repo.id, p).then(onChange);

  const review = async () => {
    const n = Number(pr);
    if (!n) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.reviewPr(repo.id, n);
      setMsg(res.status === "queued" ? `Queued review of #${n}` : `Skipped: ${res.reason}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card repo">
      <div className="repo-head">
        <div>
          <span className="repo-name">{repo.fullName}</span>
          {repo.isPrivate && <span className="badge">private</span>}
          <span className="badge subtle">{repo.provider}</span>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={repo.autoReviewEnabled}
            onChange={(e) => patch({ autoReviewEnabled: e.target.checked })}
          />
          <span className="slider" />
          <span className="toggle-label">{repo.autoReviewEnabled ? "Auto review" : "Manual"}</span>
        </label>
      </div>
      <div className="repo-controls">
        <label>
          Model
          <input
            placeholder="(default)"
            defaultValue={repo.model ?? ""}
            onBlur={(e) => patch({ model: e.target.value || null })}
          />
        </label>
        <label>
          Daily cap $
          <input
            type="number"
            step="0.5"
            placeholder="none"
            defaultValue={repo.dailyCostCapUsd ?? ""}
            onBlur={(e) => patch({ dailyCostCapUsd: e.target.value ? Number(e.target.value) : null })}
          />
        </label>
        <div className="review-inline">
          <input placeholder="PR #" value={pr} onChange={(e) => setPr(e.target.value)} />
          <button className="btn small primary" disabled={busy || !pr} onClick={review}>
            {busy ? "…" : "Review"}
          </button>
        </div>
      </div>
      {msg && <div className="repo-msg muted">{msg}</div>}
    </div>
  );
}

function PullsPanel() {
  const { data, reload } = useAsync<PullRequestDTO[]>(() => api.pulls(), []);
  const [syncing, setSyncing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const sync = async () => {
    setSyncing(true);
    setMsg(null);
    try {
      const r = await api.syncPulls();
      setMsg(
        `Synced ${r.open} open PR(s) across ${r.repos} repo(s)` +
          (r.cappedRepos
            ? ` (${r.cappedRepos} repo(s) hit the 1000-PR listing cap — some open PRs may not be shown)`
            : "") +
          ".",
      );
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "error");
    } finally {
      setSyncing(false);
    }
  };

  const review = async (pr: PullRequestDTO) => {
    setBusyId(pr.id);
    setMsg(null);
    try {
      const res = await api.reviewPr(pr.repoId, pr.number);
      setMsg(
        res.status === "queued"
          ? `Queued review of ${pr.repoFullName} #${pr.number}.`
          : `Skipped: ${res.reason}`,
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section>
      <div className="row between">
        <h2>Pull Requests</h2>
        <div className="row gap">
          <button className="btn small ghost" onClick={sync} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync from GitHub"}
          </button>
          <button className="btn ghost" onClick={reload}>
            ⟳ Refresh
          </button>
        </div>
      </div>
      <p className="muted">
        Open PRs across your connected repos. New PRs are detected automatically from GitHub events;
        use “Sync from GitHub” to backfill PRs opened before detection was enabled. Reviewing a PR
        consumes quota — auto-detection does not.
      </p>
      {msg && <div className="repo-msg muted">{msg}</div>}
      <table className="table">
        <thead>
          <tr>
            <th>Repo</th>
            <th>PR</th>
            <th>Title</th>
            <th>Author</th>
            <th>Updated</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((p) => (
            <tr key={p.id}>
              <td className="mono">{p.repoFullName}</td>
              <td>
                <a href={p.htmlUrl} target="_blank" rel="noreferrer">
                  #{p.number}
                </a>
              </td>
              <td>
                {p.title || <span className="muted">(no title)</span>}
                {p.isDraft && <span className="badge subtle">draft</span>}
                {!p.autoReviewEnabled && <span className="badge subtle">manual</span>}
              </td>
              <td className="muted">{p.author ?? "—"}</td>
              <td className="muted">
                {p.prUpdatedAt ? new Date(p.prUpdatedAt).toLocaleString() : "—"}
              </td>
              <td>
                <button
                  className="btn small primary"
                  disabled={busyId === p.id}
                  onClick={() => review(p)}
                >
                  {busyId === p.id ? "…" : "Review"}
                </button>
              </td>
            </tr>
          ))}
          {!data?.length && (
            <tr>
              <td colSpan={6} className="muted">
                No open PRs detected yet. Click “Sync from GitHub” to backfill existing ones.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function RunnersPanel() {
  const { data, reload } = useAsync<RunnerDTO[]>(() => api.runners(), []);
  useEffect(() => {
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reload]);

  return (
    <section>
      <div className="row between">
        <h2>Runners</h2>
        <button className="btn ghost" onClick={reload}>
          ⟳ Refresh
        </button>
      </div>
      <p className="muted">
        Runners run on machines where Claude is logged in. Enroll one with the runner daemon and the
        shared enrollment secret.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Name</th>
            <th>Providers</th>
            <th>Last seen</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((r) => (
            <tr key={r.id}>
              <td>
                <span className={`dot ${r.status}`} /> {r.status}
              </td>
              <td>{r.name}</td>
              <td className="muted">{r.capabilities?.providers?.join(", ")}</td>
              <td className="muted">{r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : "—"}</td>
              <td>
                {!r.revokedAt && (
                  <button className="link danger" onClick={() => api.revokeRunner(r.id).then(reload)}>
                    revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
          {!data?.length && (
            <tr>
              <td colSpan={5} className="muted">
                No runners enrolled.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function ActivityPanel() {
  const { data, reload } = useAsync<JobDTO[]>(() => api.jobs(), []);
  useEffect(() => {
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reload]);

  return (
    <section>
      <div className="row between">
        <h2>Activity</h2>
        <button className="btn ghost" onClick={reload}>
          ⟳ Refresh
        </button>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>PR</th>
            <th>State</th>
            <th>Trigger</th>
            <th>Round</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((j) => (
            <tr key={j.id}>
              <td>
                <span className="mono">{j.repoFullName}</span> #{j.prNumber}
              </td>
              <td>
                <span className={`state ${j.state}`}>{j.state}</span>
                {j.errorMessage && <div className="err">{j.errorMessage}</div>}
              </td>
              <td className="muted">{j.trigger}</td>
              <td className="muted">{j.round}</td>
              <td className="muted">{new Date(j.createdAt).toLocaleTimeString()}</td>
            </tr>
          ))}
          {!data?.length && (
            <tr>
              <td colSpan={5} className="muted">
                No jobs yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function UsagePanel() {
  const { data } = useAsync<UsageSummary>(() => api.usage(), []);
  return (
    <section>
      <h2>Usage &amp; spend</h2>
      <div className="stats">
        <Stat label="Today" value={data ? `$${data.today.toFixed(2)}` : "—"} />
        <Stat label="Last 7 days" value={data ? `$${data.last7d.toFixed(2)}` : "—"} />
        <Stat label="Last 30 days" value={data ? `$${data.last30d.toFixed(2)}` : "—"} />
        <Stat label="Total runs" value={data ? String(data.totalRuns) : "—"} />
      </div>
      <p className="muted small">{data?.note}</p>
      {data && (
        <a className="btn small ghost" href={data.claudeConsoleUrl} target="_blank" rel="noreferrer">
          Open Claude usage console ↗
        </a>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label muted">{label}</div>
    </div>
  );
}
