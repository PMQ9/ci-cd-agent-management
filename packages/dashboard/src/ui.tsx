// Small WebTUI presentational helpers shared across the dashboard.
import type { ReactNode } from "react";

type Tone = "neutral" | "green" | "red" | "blue" | "yellow" | "mauve" | "peach";

/** A WebTUI badge. Colored tones set --badge-color via the `.b-*` classes in styles.css;
 *  the neutral tone uses the built-in `background2` variant. `cap` is a WebTUI cap shape. */
export function Badge({
  tone = "neutral",
  cap,
  children,
}: {
  tone?: Tone;
  cap?: string;
  children: ReactNode;
}) {
  return (
    <span
      is-="badge"
      className={tone === "neutral" ? undefined : `b-${tone}`}
      variant-={tone === "neutral" ? "background2" : undefined}
      cap-={cap}
    >
      {children}
    </span>
  );
}

// Job state → badge tone + cap shape. Covers every value in shared JOB_STATES,
// with a neutral fallback for anything new.
const JOB_BADGE: Record<string, { tone: Tone; cap?: string }> = {
  queued: { tone: "blue", cap: "slant-top" },
  leased: { tone: "blue", cap: "slant-top" },
  running: { tone: "yellow", cap: "triangle" },
  succeeded: { tone: "green", cap: "round" },
  failed: { tone: "red", cap: "ribbon" },
  cancelled: { tone: "neutral" },
  superseded: { tone: "neutral" },
};

export function JobBadge({ state }: { state: string }) {
  const m = JOB_BADGE[state] ?? { tone: "neutral" as Tone };
  return (
    <Badge tone={m.tone} cap={m.cap}>
      {state}
    </Badge>
  );
}

// PR-row review status: friendlier than the raw job state (used on the Activity
// tab via JobBadge). Maps the latest job's state to a plain-language label + tone,
// and explains the "queued but nothing can run it" case when no runner is online.
const REVIEW_STATUS: Record<string, { label: string; tone: Tone; cap?: string }> = {
  queued: { label: "Queued", tone: "blue", cap: "slant-top" },
  leased: { label: "Reviewing…", tone: "yellow", cap: "triangle" },
  running: { label: "Reviewing…", tone: "yellow", cap: "triangle" },
  succeeded: { label: "Reviewed ✓", tone: "green", cap: "round" },
  failed: { label: "Failed", tone: "red", cap: "ribbon" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  superseded: { label: "Superseded", tone: "neutral" },
};

export function ReviewStatusBadge({
  state,
  errorMessage,
  runnerOnline,
}: {
  state: string | null;
  errorMessage?: string | null;
  runnerOnline?: boolean;
}) {
  if (!state) return <span className="dim">not reviewed</span>;
  const m = REVIEW_STATUS[state] ?? { label: state, tone: "neutral" as Tone };
  // A queued review can't start until a runner picks it up; if none is online it's
  // effectively stalled, so say so right on the row.
  const stalled = state === "queued" && runnerOnline === false;
  return (
    <>
      <Badge tone={m.tone} cap={m.cap}>
        {m.label}
      </Badge>
      {stalled && <span className="dim"> · no runner online ⚠</span>}
      {state === "failed" && errorMessage && <div className="err">{errorMessage}</div>}
    </>
  );
}

/** A bordered panel with its title sitting on the top border line (TUI "legend" look). */
export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel" box-="round">
      <span className="panel-title">{title}</span>
      {children}
    </section>
  );
}
