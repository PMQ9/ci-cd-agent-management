// Renders the authed App, switches to the Service Status tab, and pins that the
// ServiceStatusPanel shows each vendor with its status badge, active incidents,
// and a link out to the upstream status page. Mocks the whole api module so
// nothing touches the network (mirrors App.smoke.test.tsx's setup).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({
  api: {
    me: vi.fn(),
    authConfig: vi.fn(),
    devLogin: vi.fn(),
    logout: vi.fn(),
    repos: vi.fn(),
    updateRepo: vi.fn(),
    reviewPr: vi.fn(),
    installations: vi.fn(),
    syncInstallation: vi.fn(),
    runners: vi.fn(),
    revokeRunner: vi.fn(),
    jobs: vi.fn(),
    usage: vi.fn(),
    pulls: vi.fn(),
    syncPulls: vi.fn(),
    templates: vi.fn(),
    updateTemplate: vi.fn(),
    prompts: vi.fn(),
    updatePrompt: vi.fn(),
    promptPreview: vi.fn(),
    vendorStatus: vi.fn(),
  },
}));

vi.mock("../src/api.js", async () => {
  const actual = await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return { AuthError: actual.AuthError, api };
});
vi.mock("../src/ThemeSwitcher.js", () => ({ ThemeSwitcher: () => null }));
vi.mock("../src/SizeSwitcher.js", () => ({ SizeSwitcher: () => null }));

const { App } = await import("../src/App.js");

const VENDOR_FIXTURE = {
  fetchedAt: "2026-06-23T18:40:00.000Z",
  vendors: [
    {
      key: "claude",
      name: "Claude",
      statusPageUrl: "https://status.claude.com/",
      level: "operational",
      description: "All Systems Operational",
      indicator: "none",
      updatedAt: "2026-06-23T18:32:57.399Z",
      incidents: [],
      ok: true,
    },
    {
      key: "cloudflare",
      name: "Cloudflare",
      statusPageUrl: "https://www.cloudflarestatus.com/",
      level: "degraded",
      description: "Minor Service Outage",
      indicator: "minor",
      updatedAt: "2026-06-23T18:38:56.082Z",
      incidents: [
        { name: "Elevated 5xx in WEUR", impact: "minor", status: "investigating", updatedAt: null },
      ],
      ok: true,
    },
    {
      key: "openai",
      name: "OpenAI",
      statusPageUrl: "https://status.openai.com/",
      level: "unknown",
      description: "Status unavailable",
      indicator: null,
      updatedAt: null,
      incidents: [],
      ok: false,
    },
  ],
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.me.mockResolvedValue({ login: "octocat" });
  api.authConfig.mockResolvedValue({ githubConfigured: true, devLoginAvailable: false });
  api.repos.mockResolvedValue([]);
  api.installations.mockResolvedValue({
    installations: [],
    installUrl: null,
    githubConfigured: true,
  });
  api.vendorStatus.mockResolvedValue(VENDOR_FIXTURE);
});

afterEach(() => {
  vi.clearAllMocks();
});

async function gotoServiceStatus(container: HTMLElement) {
  // Wait for the authed shell, then click the Service Status nav button.
  await screen.findByText("@octocat");
  fireEvent.click(screen.getByRole("button", { name: /service status/i }));
  await waitFor(() =>
    expect(container.querySelector(".panel-title")!.textContent).toBe("Service Status"),
  );
}

describe("ServiceStatusPanel", () => {
  it("renders each vendor with its status badge", async () => {
    const { container } = render(<App />);
    await gotoServiceStatus(container);

    expect(api.vendorStatus).toHaveBeenCalled();
    expect(await screen.findByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Cloudflare")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();

    // Status badges: degraded + unknown are unique levels in the fixture.
    expect(screen.getByText("degraded")).toBeInTheDocument();
    expect(screen.getByText("unknown")).toBeInTheDocument();
    // operational appears once here (Claude); it renders as a badge.
    expect(screen.getByText("operational")).toBeInTheDocument();
  });

  it("lists a vendor's active incidents", async () => {
    const { container } = render(<App />);
    await gotoServiceStatus(container);

    expect(await screen.findByText(/Elevated 5xx in WEUR/)).toBeInTheDocument();
  });

  it("links each vendor out to its upstream status page", async () => {
    const { container } = render(<App />);
    await gotoServiceStatus(container);

    await screen.findByText("Claude");
    const links = screen.getAllByRole("link", { name: /view/i });
    const hrefs = links.map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://status.claude.com/");
    expect(hrefs).toContain("https://www.cloudflarestatus.com/");
    // Links open in a new tab safely.
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(links[0]).toHaveAttribute("rel", "noreferrer");
  });

  it("surfaces a load error", async () => {
    api.vendorStatus.mockRejectedValue(new Error("boom"));
    const { container } = render(<App />);
    await gotoServiceStatus(container);

    expect(await screen.findByText(/Error: boom/)).toBeInTheDocument();
  });
});
