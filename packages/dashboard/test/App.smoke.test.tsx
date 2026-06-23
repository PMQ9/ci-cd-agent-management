// Light smoke for src/App.tsx — pins the auth gate only:
//   - api.me() rejecting with AuthError → the login screen shows a sign-in affordance.
//   - api.me() resolving with a login → the authed shell renders (a known panel title).
// We mock the whole api module so nothing touches the network. The real AuthError
// class is re-exported from the mock so `e instanceof AuthError` keeps working.
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real AuthError so App's `instanceof AuthError` branch is exercised faithfully.
import { AuthError } from "../src/api.js";

// vi.mock is hoisted above imports, so the mock's api object must be created via
// vi.hoisted to be available inside the (also-hoisted) factory.
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
  },
}));

vi.mock("../src/api.js", async () => {
  const actual = await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return { AuthError: actual.AuthError, api };
});

// ThemeSwitcher / SizeSwitcher touch localStorage on mount; harmless in jsdom but
// stub them to keep the authed-shell render focused on App's own structure.
vi.mock("../src/ThemeSwitcher.js", () => ({ ThemeSwitcher: () => null }));
vi.mock("../src/SizeSwitcher.js", () => ({ SizeSwitcher: () => null }));

// Import App AFTER the mocks are registered.
const { App } = await import("../src/App.js");

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  // Sensible defaults for the list endpoints any panel might call.
  api.authConfig.mockResolvedValue({ githubConfigured: true, devLoginAvailable: false });
  api.repos.mockResolvedValue([]);
  api.installations.mockResolvedValue({
    installations: [],
    installUrl: null,
    githubConfigured: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("App auth gate", () => {
  it("shows the sign-in affordance when api.me() rejects with AuthError", async () => {
    api.me.mockRejectedValue(new AuthError());

    render(<App />);

    // LoginScreen renders the GitHub sign-in link once authConfig resolves.
    const link = await screen.findByText(/sign in with github/i);
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/auth/login");
  });

  it("shows the dev-login button when authConfig reports it available", async () => {
    api.me.mockRejectedValue(new AuthError());
    api.authConfig.mockResolvedValue({ githubConfigured: false, devLoginAvailable: true });

    render(<App />);

    expect(await screen.findByText(/dev login/i)).toBeInTheDocument();
    // GitHub-not-configured warning shows instead of the sign-in link.
    expect(screen.queryByText(/sign in with github/i)).not.toBeInTheDocument();
  });

  it("renders the authed shell (default Repositories panel) when api.me() resolves", async () => {
    api.me.mockResolvedValue({ login: "octocat" });

    const { container } = render(<App />);

    // The signed-in user handle in the sidebar is unique → use it as the
    // "authed shell rendered" anchor.
    expect(await screen.findByText("@octocat")).toBeInTheDocument();

    // The default tab is "repos" → the Panel title (TAB_LABELS.repos) is
    // "Repositories". ("Repositories" also appears in the nav button, so target
    // the unique .panel-title rather than a bare text match.)
    const panelTitle = container.querySelector(".panel-title");
    expect(panelTitle).not.toBeNull();
    expect(panelTitle!.textContent).toBe("Repositories");

    // A repos-panel-specific string confirms ReposPanel actually mounted.
    expect(
      screen.getByText("Repositories connected to the GitHub App."),
    ).toBeInTheDocument();

    // The login screen affordance must NOT be present in the authed shell.
    expect(screen.queryByText(/sign in with github/i)).not.toBeInTheDocument();
  });

  it("does not render the login screen while the auth check is still pending (shows Loading…)", async () => {
    // me() never resolves → authChecked stays false → Loading… branch.
    api.me.mockReturnValue(new Promise(() => {}));

    render(<App />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByText(/sign in with github/i)).not.toBeInTheDocument();
    // Give microtasks a beat; the gate must still be on Loading…
    await waitFor(() => expect(screen.getByText(/loading/i)).toBeInTheDocument());
  });
});
