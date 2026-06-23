import { useCallback, useEffect, useState } from "react";
import {
  type AgentPromptDTO,
  type AuthConfig,
  AuthError,
  api,
  type InstallationsResponse,
  type JobDTO,
  type PullRequestDTO,
  type RepoDTO,
  type RunnerDTO,
  type TemplateDTO,
  type UsageSummary,
  type VendorStatusResponse,
} from "./api.js";
import { SizeSwitcher } from "./SizeSwitcher.js";
import { ThemeSwitcher } from "./ThemeSwitcher.js";
import { Badge, JobBadge, Panel, ReviewStatusBadge, VendorStatusBadge } from "./ui.js";

type Tab =
  | "repos"
  | "templates"
  | "prompts"
  | "pulls"
  | "runners"
  | "status"
  | "activity"
  | "usage";
const TAB_LABELS: Record<Tab, string> = {
  repos: "Repositories",
  templates: "Review Templates",
  prompts: "System Prompts",
  pulls: "Pull Requests",
  runners: "Runners",
  status: "Service Status",
  activity: "Activity",
  usage: "Usage & spend",
};
const NAV_GLYPH: Record<Tab, string> = {
  repos: "▤",
  templates: "▦",
  prompts: "✎",
  pulls: "⇄",
  runners: "◇",
  status: "◉",
  activity: "◷",
  usage: "$",
};
const ORDER: Tab[] = [
  "repos",
  "templates",
  "prompts",
  "pulls",
  "runners",
  "status",
  "activity",
  "usage",
];

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
              type="button"
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
          <SizeSwitcher />
          <div className="user">
            <span className="dim">@{login}</span>
            <button
              type="button"
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
          {tab === "templates" && <TemplatesPanel />}
          {tab === "prompts" && <PromptsPanel />}
          {tab === "pulls" && <PullsPanel />}
          {tab === "runners" && <RunnersPanel />}
          {tab === "status" && <ServiceStatusPanel />}
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
          <p className="warn">
            GitHub App not configured — set the GITHUB_* env vars to enable GitHub sign-in.
          </p>
        )}
        {cfg?.devLoginAvailable && (
          <button
            type="button"
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
    // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` is the caller-supplied dynamic dependency array for this generic useAsync hook
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
                  type="button"
                  key={i.id}
                  size-="small"
                  variant-="background2"
                  onClick={() => api.syncInstallation(i.id).then(reload)}
                >
                  Sync
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
          <button
            type="button"
            className="btn-accent"
            size-="small"
            disabled={busy || !pr}
            onClick={review}
          >
            {busy ? "…" : "Review"}
          </button>
        </div>
      </div>
      {msg && <div className="repo-msg">{msg}</div>}
    </div>
  );
}

const KIND_LABEL: Record<TemplateDTO["kind"], string> = {
  pr_review: "PR review",
  pull_request: "PR description",
  security_review: "security",
};

function TemplatesPanel() {
  const { data, reload } = useAsync<TemplateDTO[]>(() => api.templates(), []);
  return (
    <>
      <div className="panel-head">
        <span className="dim">
          Templates the system knows about. The <strong>active PR review</strong> template is the
          rubric every AI review is forced to fill — edit it here and reviews use it on the next
          run.
        </span>
      </div>
      {!data?.length && <p className="dim">No templates yet.</p>}
      {data?.map((t) => (
        <TemplateCard key={t.id} t={t} onChange={reload} />
      ))}
    </>
  );
}

function TemplateCard({ t, onChange }: { t: TemplateDTO; onChange: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const patch = (p: Partial<Pick<TemplateDTO, "content" | "description" | "isActive">>) =>
    api
      .updateTemplate(t.id, p)
      .then(() => {
        setMsg("Saved.");
        onChange();
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : "error"));

  return (
    <div className="repo" box-="round">
      <div className="repo-head">
        <span className="repo-name">{t.name}</span>
        <Badge tone="mauve" cap="round">
          {KIND_LABEL[t.kind]}
        </Badge>
        {t.isActive && (
          <Badge tone="green" cap="round">
            active rubric
          </Badge>
        )}
        <div is-="separator" variant-="foreground2" className="connector" />
        {t.kind === "pr_review" && !t.isActive && (
          <button
            type="button"
            size-="small"
            variant-="background2"
            onClick={() => patch({ isActive: true })}
          >
            Set as active rubric
          </button>
        )}
      </div>
      {t.description && <p className="panel-desc">{t.description}</p>}
      <label className="field tpl-field">
        Template content (markdown)
        <textarea
          className="tpl-text"
          defaultValue={t.content}
          spellCheck={false}
          onBlur={(e) => {
            if (e.target.value !== t.content) patch({ content: e.target.value });
          }}
        />
      </label>
      {msg && <div className="repo-msg">{msg}</div>}
    </div>
  );
}

function PromptsPanel() {
  const { data, reload } = useAsync<AgentPromptDTO[]>(() => api.prompts(), []);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const showPreview = async () => {
    setPreviewing(true);
    try {
      const r = await api.promptPreview();
      setPreview(r.instruction);
    } catch (e) {
      setPreview(e instanceof Error ? e.message : "error");
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <>
      <div className="panel-head between">
        <span className="dim">
          The system prompt the AI reviewer runs with, in editable pieces. Changes apply to the next
          review. The output contract is fixed so the result parser can’t break.
        </span>
        <button
          type="button"
          size-="small"
          variant-="background2"
          disabled={previewing}
          onClick={showPreview}
        >
          {previewing ? "…" : "Preview assembled instruction"}
        </button>
      </div>
      {data?.map((p) => (
        <PromptCard key={p.key} p={p} onChange={reload} />
      ))}
      {preview && (
        <div className="repo" box-="round">
          <div className="repo-head">
            <span className="repo-name">Assembled instruction</span>
            <span className="dim small">exactly what the runner sends to claude -p</span>
          </div>
          <pre className="tpl-preview">{preview}</pre>
        </div>
      )}
    </>
  );
}

function PromptCard({ p, onChange }: { p: AgentPromptDTO; onChange: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const save = (content: string) => {
    if (content === p.content) return;
    api
      .updatePrompt(p.key, content)
      .then(() => {
        setMsg("Saved.");
        onChange();
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : "error"));
  };

  return (
    <div className="repo" box-="round">
      <div className="repo-head">
        <span className="repo-name">{p.label}</span>
        {!p.editable && (
          <Badge tone="peach" cap="round">
            read-only
          </Badge>
        )}
        <div is-="separator" variant-="foreground2" className="connector" />
        <code className="dim small">{p.key}</code>
      </div>
      {p.description && <p className="panel-desc">{p.description}</p>}
      <label className="field tpl-field">
        <textarea
          className="tpl-text"
          defaultValue={p.content}
          readOnly={!p.editable}
          spellCheck={false}
          onBlur={p.editable ? (e) => save(e.target.value) : undefined}
        />
      </label>
      {msg && <div className="repo-msg">{msg}</div>}
    </div>
  );
}

const ACTIVE_JOB_STATES = ["queued", "leased", "running"];

function PullsPanel() {
  const { data, reload } = useAsync<PullRequestDTO[]>(() => api.pulls(), []);
  const { data: runners, reload: reloadRunners } = useAsync<RunnerDTO[]>(() => api.runners(), []);
  const [syncing, setSyncing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Live-update status (queued → reviewing → reviewed) like the Runners/Activity panels.
  useEffect(() => {
    const t = setInterval(() => {
      reload();
      reloadRunners();
    }, 5000);
    return () => clearInterval(t);
  }, [reload, reloadRunners]);

  const anyRunnerOnline = (runners ?? []).some((r) => r.status === "online");
  // A queued/leased/running review can't progress with no runner online → explain why.
  const hasStalledQueue =
    !anyRunnerOnline &&
    (data ?? []).some((p) => p.jobState != null && ACTIVE_JOB_STATES.includes(p.jobState));

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
      // Reflect the freshly-queued job in the row right away (don't wait for the poll).
      reload();
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
          <button
            type="button"
            size-="small"
            variant-="background2"
            onClick={sync}
            disabled={syncing}
          >
            {syncing ? "Syncing…" : "Sync from GitHub"}
          </button>
          <button type="button" size-="small" variant-="background2" onClick={reload}>
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
      {hasStalledQueue && (
        <div className="repo-msg">
          ⚠ No runner is online — queued reviews won't start until a runner connects (see the
          Runners tab).
        </div>
      )}
      <div className="table-wrap">
        <table className="tbl" divide-="horizontal">
          <thead>
            <tr>
              <th>Repo</th>
              <th className="nowrap">PR</th>
              <th>Title</th>
              <th className="nowrap">Author</th>
              <th className="nowrap">Updated</th>
              <th className="nowrap">Status</th>
              <th className="nowrap" />
            </tr>
          </thead>
          <tbody>
            {data?.map((p) => (
              <tr key={p.id}>
                <td>{p.repoFullName}</td>
                <td className="nowrap">
                  <a href={p.htmlUrl} target="_blank" rel="noreferrer">
                    #{p.number}
                  </a>
                </td>
                <td>
                  {p.title || <span className="dim">(no title)</span>}{" "}
                  {p.isDraft && <Badge>draft</Badge>}{" "}
                  {!p.autoReviewEnabled && <Badge>manual</Badge>}
                </td>
                <td className="dim nowrap">{p.author ?? "—"}</td>
                <td className="dim nowrap">
                  {p.prUpdatedAt ? new Date(p.prUpdatedAt).toLocaleString() : "—"}
                </td>
                <td className="nowrap">
                  <ReviewStatusBadge
                    state={p.jobState}
                    errorMessage={p.jobErrorMessage}
                    runnerOnline={anyRunnerOnline}
                  />
                </td>
                <td className="nowrap">
                  <button
                    type="button"
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
                <td colSpan={7} className="dim">
                  No open PRs detected yet. Click “Sync from GitHub” to backfill existing ones.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
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
        <button type="button" size-="small" variant-="background2" onClick={reload}>
          ⟳ Refresh
        </button>
      </div>
      <p className="panel-desc">
        Enroll one with the runner daemon and the shared enrollment secret.
      </p>
      <div className="table-wrap">
        <table className="tbl" divide-="horizontal">
          <thead>
            <tr>
              <th className="nowrap">Status</th>
              <th>Name</th>
              <th>Providers</th>
              <th className="nowrap">Last seen</th>
              <th className="nowrap" />
            </tr>
          </thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.id}>
                <td className="nowrap">
                  <Badge tone={r.status === "online" ? "green" : "neutral"} cap="round">
                    {r.status}
                  </Badge>
                </td>
                <td>{r.name}</td>
                <td className="dim">{r.capabilities?.providers?.join(", ")}</td>
                <td className="dim nowrap">
                  {r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : "—"}
                </td>
                <td className="nowrap">
                  {!r.revokedAt && (
                    <button
                      type="button"
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
      </div>
    </>
  );
}

function ServiceStatusPanel() {
  const { data, error, loading, reload } = useAsync<VendorStatusResponse>(
    () => api.vendorStatus(),
    [],
  );
  // Vendor status changes on the order of minutes; poll slower than the infra
  // panels (and the control plane caches for ~60s, so this won't hit upstream).
  useEffect(() => {
    const t = setInterval(reload, 60000);
    return () => clearInterval(t);
  }, [reload]);

  return (
    <>
      <div className="panel-head">
        <span className="dim">
          Live status of the external services this control plane depends on.
        </span>
        <button
          type="button"
          size-="small"
          variant-="background2"
          onClick={reload}
          disabled={loading}
        >
          {loading ? "…" : "⟳ Refresh"}
        </button>
      </div>
      {data?.fetchedAt && (
        <p className="panel-desc">Checked {new Date(data.fetchedAt).toLocaleTimeString()}.</p>
      )}
      {error && <div className="repo-msg">Error: {error}</div>}
      <div className="table-wrap">
        <table className="tbl" divide-="horizontal">
          <thead>
            <tr>
              <th>Service</th>
              <th className="nowrap">Status</th>
              <th>Details</th>
              <th className="nowrap">Updated</th>
              <th className="nowrap" />
            </tr>
          </thead>
          <tbody>
            {data?.vendors.map((v) => (
              <tr key={v.key}>
                <td>{v.name}</td>
                <td className="nowrap">
                  <VendorStatusBadge level={v.level} />
                </td>
                <td>
                  <span className="dim">{v.description}</span>
                  {v.incidents.length > 0 && (
                    <ul className="incidents">
                      {v.incidents.map((inc) => (
                        <li key={inc.name}>
                          <strong>{inc.impact}</strong> · {inc.name}{" "}
                          <span className="dim">({inc.status})</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="dim nowrap">
                  {v.updatedAt ? new Date(v.updatedAt).toLocaleTimeString() : "—"}
                </td>
                <td className="nowrap">
                  <a href={v.statusPageUrl} target="_blank" rel="noreferrer">
                    view ↗
                  </a>
                </td>
              </tr>
            ))}
            {!data && !error && (
              <tr>
                <td colSpan={5} className="dim">
                  Loading…
                </td>
              </tr>
            )}
            {data && !data.vendors.length && (
              <tr>
                <td colSpan={5} className="dim">
                  No services configured.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
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
        <button type="button" size-="small" variant-="background2" onClick={reload}>
          ⟳ Refresh
        </button>
      </div>
      <div className="table-wrap">
        <table className="tbl" divide-="horizontal">
          <thead>
            <tr>
              <th>PR</th>
              <th>State</th>
              <th className="nowrap">Trigger</th>
              <th className="nowrap">Round</th>
              <th className="nowrap">When</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((j) => (
              <tr key={j.id}>
                <td>
                  {j.repoFullName} <span className="nowrap">#{j.prNumber}</span>
                </td>
                <td>
                  <JobBadge state={j.state} />
                  {j.errorMessage && <div className="err">{j.errorMessage}</div>}
                </td>
                <td className="dim nowrap">{j.trigger}</td>
                <td className="dim nowrap">{j.round}</td>
                <td className="dim nowrap">{new Date(j.createdAt).toLocaleTimeString()}</td>
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
      </div>
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
