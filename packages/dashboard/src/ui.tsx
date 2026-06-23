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

/** A bordered panel with its title sitting on the top border line (TUI "legend" look). */
export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel" box-="round">
      <span className="panel-title">{title}</span>
      {children}
    </section>
  );
}
