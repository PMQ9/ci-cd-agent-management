// Pins the WebTUI presentational helpers in src/ui.tsx:
//   - JobBadge handles every shared JOB_STATES value + a neutral fallback.
//   - Badge color classes: neutral has no b-* class; colored tones add b-<tone>.
//   - Panel renders its title + children.
// The dashboard package does not declare @agentpr/shared as a dependency, so the
// bare workspace specifier doesn't resolve from here — import the canonical
// JOB_STATES tuple from shared's source via a relative path instead. This is
// still the single source of truth (shared/src re-exports it), so the drift
// guard below ("every job state renders") stays honest.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JOB_STATES } from "../../shared/src/index.js";
import { Badge, JobBadge, Panel, ReviewStatusBadge } from "../src/ui.js";

describe("JobBadge", () => {
  it.each(
    JOB_STATES.map((s) => [s]),
  )("renders the '%s' job state text without crashing (drift guard)", (state) => {
    const { container } = render(<JobBadge state={state} />);
    // the state label is rendered as the badge text
    expect(screen.getByText(state)).toBeInTheDocument();
    // it renders a WebTUI badge element
    expect(container.querySelector('[is-="badge"]')).not.toBeNull();
  });

  it("renders an unknown state and falls back to the neutral tone (no b-* class)", () => {
    const { container } = render(<JobBadge state="weird" />);
    expect(screen.getByText("weird")).toBeInTheDocument();
    const badge = container.querySelector('[is-="badge"]')!;
    // neutral fallback => no colored b-* class; uses the background2 variant instead
    expect(badge.className).not.toMatch(/\bb-/);
    expect(badge.getAttribute("variant-")).toBe("background2");
  });

  it("maps known states to their colored tone (succeeded → b-green, failed → b-red)", () => {
    const { container: ok } = render(<JobBadge state="succeeded" />);
    expect(ok.querySelector('[is-="badge"]')!.className).toContain("b-green");

    const { container: bad } = render(<JobBadge state="failed" />);
    expect(bad.querySelector('[is-="badge"]')!.className).toContain("b-red");
  });

  it("renders cancelled/superseded with the neutral tone (no colored class)", () => {
    for (const state of ["cancelled", "superseded"]) {
      const { container } = render(<JobBadge state={state} />);
      const badge = container.querySelector('[is-="badge"]')!;
      expect(badge.className).not.toMatch(/\bb-/);
      expect(badge.getAttribute("variant-")).toBe("background2");
    }
  });
});

describe("ReviewStatusBadge", () => {
  it("renders 'not reviewed' (no badge) when there is no job", () => {
    const { container } = render(<ReviewStatusBadge state={null} />);
    expect(screen.getByText("not reviewed")).toBeInTheDocument();
    expect(container.querySelector('[is-="badge"]')).toBeNull();
  });

  it.each([
    ["queued", "Queued", "b-blue"],
    ["leased", "Reviewing…", "b-yellow"],
    ["running", "Reviewing…", "b-yellow"],
    ["succeeded", "Reviewed ✓", "b-green"],
    ["failed", "Failed", "b-red"],
  ] as const)("maps '%s' to label '%s' with tone %s", (state, label, cls) => {
    const { container } = render(<ReviewStatusBadge state={state} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.querySelector('[is-="badge"]')!.className).toContain(cls);
  });

  it("renders cancelled/superseded with a neutral badge (no colored class)", () => {
    for (const state of ["cancelled", "superseded"]) {
      const { container } = render(<ReviewStatusBadge state={state} />);
      const badge = container.querySelector('[is-="badge"]')!;
      expect(badge.className).not.toMatch(/\bb-/);
    }
  });

  it("shows the 'no runner online' note for a queued review when none is online", () => {
    render(<ReviewStatusBadge state="queued" runnerOnline={false} />);
    expect(screen.getByText(/no runner online/i)).toBeInTheDocument();
  });

  it("omits the 'no runner online' note when a runner is online", () => {
    render(<ReviewStatusBadge state="queued" runnerOnline={true} />);
    expect(screen.queryByText(/no runner online/i)).not.toBeInTheDocument();
  });

  it("shows the error message on a failed review", () => {
    render(<ReviewStatusBadge state="failed" errorMessage="boom: claude not found" />);
    expect(screen.getByText("boom: claude not found")).toBeInTheDocument();
  });
});

describe("Badge", () => {
  it("neutral tone (default) adds NO b-* class and uses the background2 variant", () => {
    const { container } = render(<Badge>plain</Badge>);
    const badge = container.querySelector('[is-="badge"]')!;
    expect(badge.className).toBe(""); // className is undefined → empty
    expect(badge.getAttribute("variant-")).toBe("background2");
    expect(screen.getByText("plain")).toBeInTheDocument();
  });

  it("explicit neutral tone behaves like the default", () => {
    const { container } = render(<Badge tone="neutral">n</Badge>);
    const badge = container.querySelector('[is-="badge"]')!;
    expect(badge.className).toBe("");
    expect(badge.getAttribute("variant-")).toBe("background2");
  });

  it("a colored tone adds the matching b-<tone> class and drops the variant", () => {
    const { container } = render(<Badge tone="green">go</Badge>);
    const badge = container.querySelector('[is-="badge"]')!;
    expect(badge.className).toBe("b-green");
    expect(badge.getAttribute("variant-")).toBeNull();
  });

  it.each([
    "red",
    "blue",
    "yellow",
    "mauve",
    "peach",
  ] as const)("tone '%s' produces class b-%s", (tone) => {
    const { container } = render(<Badge tone={tone}>x</Badge>);
    expect(container.querySelector('[is-="badge"]')!.className).toBe(`b-${tone}`);
  });

  it("passes a cap shape through to the cap- attribute", () => {
    const { container } = render(
      <Badge tone="green" cap="round">
        capped
      </Badge>,
    );
    expect(container.querySelector('[is-="badge"]')!.getAttribute("cap-")).toBe("round");
  });
});

describe("Panel", () => {
  it("renders its title and children", () => {
    render(
      <Panel title="Runners">
        <span>inner content</span>
      </Panel>,
    );
    expect(screen.getByText("Runners")).toBeInTheDocument();
    expect(screen.getByText("inner content")).toBeInTheDocument();
  });

  it("renders the title in a .panel-title inside a .panel section", () => {
    const { container } = render(<Panel title="Usage">body</Panel>);
    const section = container.querySelector("section.panel")!;
    expect(section).not.toBeNull();
    expect(section.getAttribute("box-")).toBe("round");
    expect(section.querySelector(".panel-title")!.textContent).toBe("Usage");
  });
});
