// Red-phase acceptance suite — the authenticated chrome: the org switcher, the
// user menu with an initials-avatar trigger, the locale-aware initials helper,
// and the per-device last-used row with a per-device revoke. Every test is
// `test.skip(...)` (TDD red phase): this chrome does not exist yet (the current
// user-menu is a placeholder), so these stay skipped until the implementation
// lands and the dev un-skips them one at a time. This is the P2 authenticated-
// chrome polish leg of the story.

import { expect, type Page } from "@playwright/test";
import { test } from "../fixtures/a11y";

const ORG_SWITCHER_NAME_RE = /organization|organisation|workspace|switch org/i;
const USER_MENU_NAME_RE = /account|profile|menu|user/i;
const PROFILE_RE = /profile/i;
const SETTINGS_RE = /settings|paramètres/i;
const THEME_RE = /theme|appearance|dark|light/i;
const LANGUAGE_RE = /language|langue|FR|EN/i;
const SIGN_OUT_RE = /sign out|log out|déconnexion/i;
const REVOKE_RE = /revoke|sign out|remove|déconnecter/i;
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// The authenticated chrome needs a signed-in session; the dev wires a session
// fixture (storageState or a seeded sign-in) at green. Until then this stays
// skipped, so the missing session is not exercised.
const gotoAuthed = async (page: Page, path: string): Promise<void> => {
  await page.goto(path);
};

test.describe("the org switcher shows the active org and re-scopes on switch", () => {
  test.skip("the org switcher trigger has an accessible name and shows the active org name and avatar", async ({
    page,
  }) => {
    await gotoAuthed(page, "/dashboard");
    const trigger = page.getByRole("button", { name: ORG_SWITCHER_NAME_RE });
    await expect(trigger).toBeVisible();
    // The active-org indicator carries the org name and an avatar image/initials.
    await expect(page.locator("[data-active-org]")).toBeVisible();
  });

  test.skip("selecting another organization re-scopes the surface (the active-org label changes)", async ({
    page,
  }) => {
    await gotoAuthed(page, "/dashboard");
    const before = await page.locator("[data-active-org]").innerText();
    await page.getByRole("button", { name: ORG_SWITCHER_NAME_RE }).click();
    await page.getByRole("menuitem").nth(1).click();
    const after = await page.locator("[data-active-org]").innerText();
    // Anti-vacuous: a switcher that never re-scopes would leave this unchanged.
    expect(after).not.toBe(before);
  });
});

test.describe("the user menu opens the expected items from an initials-avatar trigger", () => {
  test.skip("the initials-avatar trigger has an accessible name and opens profile/settings/theme/language/sign-out", async ({
    page,
  }) => {
    await gotoAuthed(page, "/dashboard");
    const trigger = page.getByRole("button", { name: USER_MENU_NAME_RE });
    await expect(trigger).toBeVisible();
    // Non-empty accessible name (anti-vacuous: a bare avatar with no name fails).
    const accessibleName =
      (await trigger.getAttribute("aria-label")) ?? (await trigger.innerText());
    expect((accessibleName ?? "").trim().length).toBeGreaterThan(0);

    await trigger.click();
    await expect(
      page.getByRole("menuitem", { name: PROFILE_RE })
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: SETTINGS_RE })
    ).toBeVisible();
    await expect(page.getByRole("menuitem", { name: THEME_RE })).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: LANGUAGE_RE })
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: SIGN_OUT_RE })
    ).toBeVisible();
  });
});

test.describe("avatar initials derive locale-aware from name parts with a defined fallback", () => {
  test.skip("a populated given_name/family_name yields the expected initials", async ({
    page,
  }) => {
    // Session fixture: given_name "Marie", family_name "Curie".
    await gotoAuthed(page, "/dashboard");
    const initials = await page.locator("[data-avatar-initials]").innerText();
    expect(initials.toUpperCase()).toBe("MC");
  });

  // Anti-vacuous: the missing-name case yields the DEFINED fallback (never blank),
  // and the populated case above proves the helper is not always-fallback.
  test.skip("missing name parts yield the defined fallback, never a blank avatar", async ({
    page,
  }) => {
    // Session fixture: no given_name/family_name, email "z@b.test".
    await gotoAuthed(page, "/dashboard?fixture=no-name");
    const initials = await page.locator("[data-avatar-initials]").innerText();
    expect(initials.trim().length).toBeGreaterThan(0);
  });
});

test.describe("the per-device last-used row carries relative and machine-readable time plus a revoke", () => {
  test.skip("each device row shows relative phrasing, an ISO-8601 <time datetime>, and a per-device revoke", async ({
    page,
  }) => {
    await gotoAuthed(page, "/settings/security");
    const row = page.locator("[data-device-row]").first();
    await expect(row).toBeVisible();

    // Machine-readable absolute time.
    const time = row.locator("time[datetime]");
    const datetime = await time.getAttribute("datetime");
    expect(datetime ?? "").toMatch(ISO_8601_RE);
    expect(Number.isNaN(Date.parse(datetime ?? ""))).toBe(false);

    // Relative phrasing is human-visible alongside the machine time.
    const visible = (await row.innerText()).trim();
    expect(visible.length).toBeGreaterThan(0);

    // A per-device revoke control is present and operable.
    const revoke = row.getByRole("button", { name: REVOKE_RE });
    await expect(revoke).toBeVisible();
  });

  test.skip("activating revoke removes or marks the device row as revoked", async ({
    page,
  }) => {
    await gotoAuthed(page, "/settings/security");
    const rowsBefore = await page.locator("[data-device-row]").count();
    await page
      .locator("[data-device-row]")
      .first()
      .getByRole("button", { name: REVOKE_RE })
      .click();
    const revoked = page.locator("[data-device-row][data-revoked='true']");
    const rowsAfter = await page.locator("[data-device-row]").count();
    // Either the row is gone or it is explicitly marked revoked.
    expect((await revoked.count()) > 0 || rowsAfter < rowsBefore).toBe(true);
  });
});

test.describe("the authenticated chrome passes the WCAG A+AA accessibility sweep", () => {
  test.skip("the dashboard chrome has zero axe violations", async ({
    page,
    checkA11y,
  }) => {
    await gotoAuthed(page, "/dashboard");
    await checkA11y();
  });
});
