import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { InitialsAvatar } from "@/components/auth/avatar";
import DeviceList, { type DeviceSession } from "@/components/device-list";
import OrgSwitcher, { type OrgSummary } from "@/components/org-switcher";
import { useLocaleStore } from "@/lib/locale-store";

// UserMenu calls authClient.useSession(); stub a signed-in member so the chrome
// renders its initials-avatar trigger + full menu deterministically.
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: {
        user: {
          name: "Marie Curie",
          email: "marie@b.test",
          given_name: "Marie",
          family_name: "Curie",
        },
      },
      isPending: false,
    }),
    signOut: vi.fn(),
  },
}));

// The reliable (vitest + jsdom) leg for the authenticated chrome: the locale-aware
// initials-avatar derivation (the gate-bearing AC), the org switcher's accessible
// trigger + re-scope, the user menu's items, and the per-device last-used row
// (relative phrasing + a machine-readable <time datetime> + a per-device revoke).

const ORGS: readonly OrgSummary[] = [
  { id: "org-a", name: "Personal Workspace" },
  { id: "org-b", name: "Acme Inc" },
];

const DEVICES: readonly DeviceSession[] = [
  {
    id: "d1",
    label: "This device",
    lastUsedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: "d2",
    label: "iPhone",
    lastUsedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  },
];

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const SWITCH_ORG_RE = /switch organization/i;
const ACCOUNT_MENU_RE = /account|menu/i;
const PROFILE_RE = /profile/i;
const SETTINGS_RE = /settings/i;
const THEME_ITEM_RE = /theme/i;
const LANGUAGE_ITEM_RE = /language/i;
const SIGN_OUT_RE = /sign out/i;
const REVOKE_RE = /revoke/i;

const withTheme = (node: ReactNode): ReactNode => (
  <ThemeProvider attribute="class" defaultTheme="light">
    {node}
  </ThemeProvider>
);

beforeEach(() => {
  useLocaleStore.setState({ locale: "en" });
});

describe("avatar initials derive locale-aware from name parts with a defined fallback", () => {
  test("a populated given/family name yields the expected initials", () => {
    render(<InitialsAvatar family_name="Curie" given_name="Marie" />);
    const avatar = screen.getByText("MC");
    expect(avatar).toHaveAttribute("data-avatar-initials", "MC");
  });

  test("missing name parts yield a defined fallback, never a blank avatar", () => {
    const { container } = render(<InitialsAvatar email="z@b.test" />);
    const avatar = container.querySelector("[data-avatar-initials]");
    expect((avatar?.textContent ?? "").trim().length).toBeGreaterThan(0);
    expect(avatar).toHaveAttribute("data-avatar-initials", "Z");
  });
});

describe("the org switcher shows the active org and re-scopes on switch", () => {
  test("the trigger has an accessible name and shows the active org", () => {
    render(<OrgSwitcher organizations={ORGS} />);
    expect(
      screen.getByRole("button", { name: SWITCH_ORG_RE })
    ).toBeInTheDocument();
    expect(screen.getByText("Personal Workspace")).toHaveAttribute(
      "data-active-org"
    );
  });

  test("selecting another organization re-scopes the active-org label", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { container } = render(<OrgSwitcher organizations={ORGS} />);
    const activeOrg = () =>
      container.querySelector("[data-active-org]")?.textContent ?? "";
    const before = activeOrg();

    await user.click(screen.getByRole("button", { name: SWITCH_ORG_RE }));
    await user.click(await screen.findByRole("menuitem", { name: "Acme Inc" }));

    expect(activeOrg()).not.toBe(before);
    expect(activeOrg()).toBe("Acme Inc");
  });
});

describe("the user menu opens the expected items from an initials-avatar trigger", () => {
  test("the trigger has a non-empty accessible name and an initials avatar", async () => {
    const UserMenu = (await import("@/components/user-menu")).default;
    render(withTheme(<UserMenu />));
    const trigger = screen.getByRole("button", { name: ACCOUNT_MENU_RE });
    expect(
      (trigger.getAttribute("aria-label") ?? "").trim().length
    ).toBeGreaterThan(0);
    expect(within(trigger).getByText("MC")).toBeInTheDocument();
  });

  test("opening the menu exposes profile, settings, theme, language and sign-out", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const UserMenu = (await import("@/components/user-menu")).default;
    render(withTheme(<UserMenu />));

    await user.click(screen.getByRole("button", { name: ACCOUNT_MENU_RE }));
    expect(
      await screen.findByRole("menuitem", { name: PROFILE_RE })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: SETTINGS_RE })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: THEME_ITEM_RE })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: LANGUAGE_ITEM_RE })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: SIGN_OUT_RE })
    ).toBeInTheDocument();
  });
});

describe("the per-device last-used row carries relative and machine-readable time plus a revoke", () => {
  test("each device row shows a relative phrasing, an ISO-8601 <time datetime>, and a revoke", () => {
    const { container } = render(<DeviceList devices={DEVICES} />);
    const rows = container.querySelectorAll("[data-device-row]");
    expect(rows.length).toBe(DEVICES.length);

    const firstRow = rows[0] as HTMLElement;
    const time = firstRow.querySelector("time");
    const datetime = time?.getAttribute("datetime") ?? "";
    expect(datetime).toMatch(ISO_8601_RE);
    expect(Number.isNaN(Date.parse(datetime))).toBe(false);
    expect((firstRow.textContent ?? "").trim().length).toBeGreaterThan(0);
    expect(
      within(firstRow).getByRole("button", { name: REVOKE_RE })
    ).toBeInTheDocument();
  });

  test("activating revoke marks the device row as revoked", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { container } = render(<DeviceList devices={DEVICES} />);
    const firstRow = container.querySelector(
      "[data-device-row]"
    ) as HTMLElement;
    await user.click(within(firstRow).getByRole("button", { name: REVOKE_RE }));
    expect(
      container.querySelector('[data-device-row][data-revoked="true"]')
    ).not.toBeNull();
  });
});
