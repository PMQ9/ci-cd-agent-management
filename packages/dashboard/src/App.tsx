import { useCallback, useEffect, useState } from "react";
import {
  AuthError,
  api,
  type AuthConfig,
  type InstallationsResponse,
  type JobDTO,
  type PullRequestDTO,
  type RepoDTO,
  type RunnerDTO,
  type UsageSummary,
} from "./api.js";
import { Badge, JobBadge, Panel } from "./ui.js";
import { ThemeSwitcher } from "./ThemeSwitcher.js";

type Tab = "repos" | "pulls" | "runners" | "activity" | "usage";
const TAB_LABELS: Record<Tab, string> = {
  repos: "Repositories",
  pulls: "Pull Requests",
  runners: "Runners",
  activity: "Activity",
  usage: "Usage & spend",
};
const NAV_GLYPH: Record<Tab, string> = {
  repos: "▤",
  pulls: "⇄",
  runners: "◇",
  activity: "◷",
  usage: "$",
};
const ORDER: Tab[] = ["repos", "pulls", "runners", "activity", "usage"];

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

  if (!authChecked) return <div className="center dim">Loading…</div>;
  if (!login) return <LoginScreen />;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">◆</span>Agent PR <span className="dim">Control Center</span>
        </div>
        <nav className="nav">
          {ORDER.map((t) => (
            <button
              key={t}
              className={tab === t ? "nav-item active" : "nav-item"}
              onClick={() => setTab(t)}
            >
              <span className="nav-glyph">{NAV_GLYPH[t]}</span>
              <span>{TAB_LABELS[t]}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <ThemeSwitcher />
          <div className="user">
            <span className="dim">@{login}</span>
            <button
              size-="small"
              variant-="background2"
              onClick={() => api.logout().then(() => location.reload())}
            >
              sign out
            </button>
          </div>
        </div>
      </aside>
      <main className="content">
        <Panel title={TAB_LABELS[tab]}>
          {tab === "repos" && <ReposPanel />}
          {tab === "pulls" && <PullsPanel />}
          {tab === "runners" && <RunnersPanel />}
          {tab === "activity" && <ActivityPanel />}
          {tab === "usage" && <UsagePanel />}
        </Panel>
      </main>
    </div>
  );
}

function LoginScreen() {
  // Ask the backend what's available — `import.meta.env.DEV` is false in the local
  // prod-preview build, so it can't tell a dev box from real production.
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  useEffect(() => {
    api
      .authConfig()
      .then(setCfg)
      .catch(() => setCfg({ githubConfigured: false, devLoginAvailable: false }));
  }, []);
  return (
    <div className="center">
      <div className="login" box-="double">
        <div className="brand big">
          <span className="logo">◆</span>Agent PR Control Center
        </div>
        <p className="dim">Sign in to manage your repos, runners, and reviews.</p>
        {cfg?.githubConfigured ? (
          <a is-="button" className="btn-accent" href="/auth/login">
            Sign in with GitHub
          </a>
        ) : (
          <p className="warn">GitHub App not configured — set the GITHUB_* env vars to enable GitHub sign-in.</p>
        )}
        {cfg?.devLoginAvailable && (
          <button
            variant-="background2"
            onClick={() => api.devLogin().then(() => location.reload())}
          >
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
  const { data: inst } = useAsync<InstallationsResponse>(() => api.installations(), []);

  return (
    <>
      <div className="panel-head">
        <span className="dim">Repositories connected to the GitHub App.</span>
        <button size-="small" variant-="background2" onClick={reload}>
          ⟳ Refresh
        </button>
      </div>

      <div className="connect" box-="square">
        {inst?.githubConfigured ? (
          <>
            <span>Connect or disconnect repos on GitHub, then sync.</span>
            <div className="row gap">
              {inst.installUrl && (
                <a
                  is-="button"
                  size-="small"
                  variant-="background2"
                  href={inst.installUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Manage on GitHub ↗
                </a>
              )}
              {inst.installations.map((i) => (
                <button
                  key={i.id}
                  size-="small"
                  variant-="background2"
                  onClick={() => api.syncInstallation(i.id).then(reload)}
                >
                  Sync {i.accountLogin}
                </button>
              ))}
            </div>
          </>
        ) : (
          <span className="warn">GitHub App not configured yet — set the GITHUB_* env vars.</span>
        )}
      </div>

      {!repos?.length && <p className="dim">No repositories connected yet.</p>}
      <div>
        {repos?.map((r) => (
          <RepoRow key={r.id} repo={r} onChange={reload} />
        ))}
      </div>
    </>
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
    <div className="repo" box-="round">
      <div className="repo-head">
        <span className="repo-name">{repo.fullName}</span>
        {repo.isPrivate && (
          <Badge tone="peach" cap="round">
            private
          </Badge>
        )}
        <Badge tone="mauve" cap="round">
          {repo.provider}
        </Badge>
        <div is-="separator" variant-="foreground2" className="connector" />
        <label className="switch-row">
          <input
            type="checkbox"
            is-="switch"
            checked={repo.autoReviewEnabled}
            onChange={(e) => patch({ autoReviewEnabled: e.target.checked })}
          />
          {repo.autoReviewEnabled ? "auto review" : "manual"}
        </label>
      </div>
      <div className="repo-controls">
        <label className="field">
          Model
          <input
            placeholder="(default)"
            defaultValue={repo.model ?? ""}
            onBlur={(e) => patch({ model: e.target.value || null })}
          />
        </label>
        <label className="field">
          Daily cap $
          <input
            type="number"
            step="0.5"
            placeholder="none"
            defaultValue={repo.dailyCostCapUsd ?? ""}
            onBlur={(e) =>
              patch({ dailyCostCapUsd: e.target.value ? Number(e.target.value) : null })
            }
          />
        </label>
        <div className="review-inline">
          <input placeholder="PR #" value={pr} onChange={(e) => setPr(e.target.value)} />
          <button className="btn-accent" size-="small" disabled={busy || !pr} onClick={review}>
            {busy ? "…" : "Review"}
          </button>
        </div>
      </div>
      {msg && <div className="repo-msg">{msg}</div>}
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
    <>
      <div className="panel-head">
        <span className="dim">Open PRs across your connected repos.</span>
        <div className="row gap">
          <button size-="small" variant-="background2" onClick={sync} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync from GitHub"}
          </button>
          <button size-="small" variant-="background2" onClick={reload}>
            ⟳ Refresh
          </button>
        </div>
      </div>
      <p className="panel-desc">
        New PRs are detected automatically from GitHub events; use “Sync from GitHub” to backfill
        PRs opened before detection was enabled. Reviewing a PR consumes quota — auto-detection does
        not.
      </p>
      {msg && <div className="repo-msg">{msg}</div>}
      <table className="tbl" divide-="horizontal">
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
              <td>{p.repoFullName}</td>
              <td>
                <a href={p.htmlUrl} target="_blank" rel="noreferrer">
                  #{p.number}
                </a>
              </td>
              <td>
                {p.title || <span className="dim">(no title)</span>}{" "}
                {p.isDraft && <Badge>draft</Badge>} {!p.autoReviewEnabled && <Badge>manual</Badge>}
              </td>
              <td className="dim">{p.author ?? "—"}</td>
              <td className="dim">
                {p.prUpdatedAt ? new Date(p.prUpdatedAt).toLocaleString() : "—"}
              </td>
              <td>
                <button
                  className="btn-accent"
                  size-="small"
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
              <td colSpan={6} className="dim">
                No open PRs detected yet. Click “Sync from GitHub” to backfill existing ones.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

function RunnersPanel() {
  const { data, reload } = useAsync<RunnerDTO[]>(() => api.runners(), []);
  useEffect(() => {
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reload]);

  return (
    <>
      <div className="panel-head">
        <span className="dim">Runners run on machines where Claude is logged in.</span>
        <button size-="small" variant-="background2" onClick={reload}>
          ⟳ Refresh
        </button>
      </div>
      <p className="panel-desc">
        Enroll one with the runner daemon and the shared enrollment secret.
      </p>
      <table className="tbl" divide-="horizontal">
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
                <Badge tone={r.status === "online" ? "green" : "neutral"} cap="round">
                  {r.status}
                </Badge>
              </td>
              <td>{r.name}</td>
              <td className="dim">{r.capabilities?.providers?.join(", ")}</td>
              <td className="dim">
                {r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : "—"}
              </td>
              <td>
                {!r.revokedAt && (
                  <button
                    className="btn-danger"
                    size-="small"
                    onClick={() => api.revokeRunner(r.id).then(reload)}
                  >
                    revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
          {!data?.length && (
            <tr>
              <td colSpan={5} className="dim">
                No runners enrolled.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

function ActivityPanel() {
  const { data, reload } = useAsync<JobDTO[]>(() => api.jobs(), []);
  useEffect(() => {
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reload]);

  return (
    <>
      <div className="panel-head">
        <span className="dim">Recent review jobs.</span>
        <button size-="small" variant-="background2" onClick={reload}>
          ⟳ Refresh
        </button>
      </div>
      <table className="tbl" divide-="horizontal">
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
                {j.repoFullName} #{j.prNumber}
              </td>
              <td>
                <JobBadge state={j.state} />
                {j.errorMessage && <div className="err">{j.errorMessage}</div>}
              </td>
              <td className="dim">{j.trigger}</td>
              <td className="dim">{j.round}</td>
              <td className="dim">{new Date(j.createdAt).toLocaleTimeString()}</td>
            </tr>
          ))}
          {!data?.length && (
            <tr>
              <td colSpan={5} className="dim">
                No jobs yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

function UsagePanel() {
  const { data } = useAsync<UsageSummary>(() => api.usage(), []);
  return (
    <>
      <div className="stats">
        <Stat label="Today" value={data ? `$${data.today.toFixed(2)}` : "—"} />
        <Stat label="Last 7 days" value={data ? `$${data.last7d.toFixed(2)}` : "—"} />
        <Stat label="Last 30 days" value={data ? `$${data.last30d.toFixed(2)}` : "—"} />
        <Stat label="Total runs" value={data ? String(data.totalRuns) : "—"} />
      </div>
      <p className="dim small">{data?.note}</p>
      {data && (
        <a
          is-="button"
          size-="small"
          variant-="background2"
          href={data.claudeConsoleUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open Claude usage console ↗
        </a>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat" box-="round">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
