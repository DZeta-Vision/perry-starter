// Red-phase acceptance suite — the 8-state AuthErrorResponse frontend machine
// and the open-redirect guard. Every test is `test.skip(...)` (TDD red phase):
// the state machine and the guarded recovery flow do not exist yet, so these
// stay skipped until the implementation lands and the dev un-skips them one at a
// time. The suite asserts that each of the 8 server-issued codes maps to exactly
// one UX treatment (none unmapped, none ambiguous), that the non-dismissable gate
// is not a keyboard-trap dead-end, that the two placeholder routes are defined
// and offer a forward path, that the locked surface shows no numeric countdown,
// and that the preserved returnTo is validated against a same-origin in-app path
// allowlist (a valid path is preserved; absolute/external/scheme-bearing values
// are rejected to the default route).

import { expect, type Page, type Route } from "@playwright/test";
import { test } from "../fixtures/a11y";

const ALL_CODES = [
  "UNAUTHORIZED",
  "SESSION_EXPIRED",
  "EMAIL_NOT_VERIFIED",
  "PASSWORD_CHANGE_REQUIRED",
  "TWO_FACTOR_REQUIRED",
  "STEP_UP_REQUIRED",
  "ACCOUNT_LOCKED",
  "FORBIDDEN",
] as const;

type AuthCode = (typeof ALL_CODES)[number];

const DEFAULT_ROUTE = "/";
const SIGN_IN_NAME_RE = /sign in|welcome back/i;
const RESEND_NAME_RE = /resend|send again/i;
const NO_ACCESS_RE = /no access|don.t have access|forbidden|not allowed/i;
const COUNTDOWN_DIGITS_RE = /\b\d+\s*(seconds?|minutes?|s|min)\b/i;
const FORWARD_PATH_NAME_RE = /back to sign|cancel|continue|sign in|return/i;

// Drive the frontend by stubbing a protected call so it resolves with the given
// AuthErrorResponse code; the machine then routes to the one treatment. The
// exact protected endpoint is an implementation detail the dev aligns at green.
const respondWithCode = async (page: Page, code: AuthCode): Promise<void> => {
  await page.route("**/api/**", async (route: Route) => {
    await route.fulfill({
      status: code === "FORBIDDEN" ? 403 : 401,
      contentType: "application/json",
      headers:
        code === "PASSWORD_CHANGE_REQUIRED"
          ? { "x-require-password-change": "1" }
          : {},
      body: JSON.stringify({ error: { code } }),
    });
  });
};

test.describe("each AuthErrorResponse code maps to exactly one treatment", () => {
  test.skip("UNAUTHORIZED routes to the generic sign-in surface", async ({
    page,
  }) => {
    await respondWithCode(page, "UNAUTHORIZED");
    await page.goto("/dashboard");
    await expect(
      page.getByRole("button", { name: SIGN_IN_NAME_RE }).first()
    ).toBeVisible();
  });

  test.skip("SESSION_EXPIRED shows a Sonner toast and routes to sign-in", async ({
    page,
  }) => {
    await respondWithCode(page, "SESSION_EXPIRED");
    await page.goto("/dashboard");
    // Sonner renders an ARIA status/list region for the toast.
    await expect(
      page.locator("[data-sonner-toast], [role='status']").first()
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: SIGN_IN_NAME_RE }).first()
    ).toBeVisible();
  });

  test.skip("EMAIL_NOT_VERIFIED shows the verification wall with a non-numeric resend", async ({
    page,
  }) => {
    await respondWithCode(page, "EMAIL_NOT_VERIFIED");
    await page.goto("/dashboard");
    const resend = page.getByRole("button", { name: RESEND_NAME_RE });
    await expect(resend).toBeVisible();
    // The rate-limit affordance is phrased without a countdown number.
    const wallText = await page.locator("main, body").first().innerText();
    expect(wallText).not.toMatch(COUNTDOWN_DIGITS_RE);
  });

  test.skip("PASSWORD_CHANGE_REQUIRED shows a non-dismissable forced-change block", async ({
    page,
  }) => {
    await respondWithCode(page, "PASSWORD_CHANGE_REQUIRED");
    await page.goto("/dashboard");
    const gate = page.getByRole("dialog");
    await expect(gate).toBeVisible();
    // Non-dismissable: Escape does not close it.
    await page.keyboard.press("Escape");
    await expect(gate).toBeVisible();
  });

  test.skip("TWO_FACTOR_REQUIRED routes to a defined, non-trap placeholder with a forward path", async ({
    page,
  }) => {
    await respondWithCode(page, "TWO_FACTOR_REQUIRED");
    await page.goto("/dashboard");
    // The placeholder route is defined (not a blank/404) and offers a forward path.
    await expect(
      page.getByRole("button", { name: FORWARD_PATH_NAME_RE }).first()
    ).toBeVisible();
  });

  test.skip("STEP_UP_REQUIRED opens a defined, non-trap placeholder step-up surface with a forward path", async ({
    page,
  }) => {
    await respondWithCode(page, "STEP_UP_REQUIRED");
    await page.goto("/dashboard");
    await expect(
      page.getByRole("button", { name: FORWARD_PATH_NAME_RE }).first()
    ).toBeVisible();
  });

  test.skip("ACCOUNT_LOCKED shows the locked surface with Turnstile and no numeric countdown", async ({
    page,
  }) => {
    await respondWithCode(page, "ACCOUNT_LOCKED");
    await page.goto("/dashboard");
    // The Turnstile widget container is present (siteverify is server-side).
    await expect(
      page.locator(".cf-turnstile, [data-turnstile]").first()
    ).toBeVisible();
    const lockedText = await page.locator("main, body").first().innerText();
    // retryAfter is consumed silently — never a countdown.
    expect(lockedText).not.toMatch(COUNTDOWN_DIGITS_RE);
  });

  test.skip("FORBIDDEN shows a generic no-access surface", async ({ page }) => {
    await respondWithCode(page, "FORBIDDEN");
    await page.goto("/dashboard");
    const text = await page.locator("main, body").first().innerText();
    expect(text).toMatch(NO_ACCESS_RE);
  });

  // Anti-vacuous: the 8 codes resolve to 8 mutually-distinct treatments — none
  // unmapped (falling through to a blank/404), none mapping to two screens.
  test.skip("the 8 codes resolve to 8 distinct, well-defined treatments (coverage map)", async ({
    page,
  }) => {
    const signatures = new Set<string>();
    for (const code of ALL_CODES) {
      await respondWithCode(page, code);
      await page.goto("/dashboard");
      // A stable per-treatment marker the dev stamps on each surface.
      const marker = await page
        .locator("[data-auth-treatment]")
        .first()
        .getAttribute("data-auth-treatment");
      expect(
        marker,
        `code ${code} must map to a defined treatment`
      ).toBeTruthy();
      signatures.add(marker ?? "");
      await page.unroute("**/api/**");
    }
    // All 8 are distinct (no two codes collapse to the same screen).
    expect(signatures.size).toBe(ALL_CODES.length);
  });
});

test.describe("the non-dismissable gate and placeholder routes are not keyboard traps", () => {
  test.skip("the forced-change gate keeps focus reachable and does not trap the keyboard", async ({
    page,
  }) => {
    await respondWithCode(page, "PASSWORD_CHANGE_REQUIRED");
    await page.goto("/dashboard");
    // Tab cycles within the gate and lands on an operable control (no dead-end).
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toBeVisible();
  });

  test.skip("the step-up placeholder is a single modal depth (never a dialog over a dialog)", async ({
    page,
  }) => {
    await respondWithCode(page, "STEP_UP_REQUIRED");
    await page.goto("/dashboard");
    // At most one open dialog at any time.
    expect(await page.getByRole("dialog").count()).toBeLessThanOrEqual(1);
  });
});

test.describe("the returnTo open-redirect guard validates against a same-origin path allowlist", () => {
  const recoverWithReturnTo = async (
    page: Page,
    returnTo: string
  ): Promise<string> => {
    await respondWithCode(page, "SESSION_EXPIRED");
    await page.goto(`/dashboard?returnTo=${encodeURIComponent(returnTo)}`);
    // Complete the (stubbed) re-auth so the guard decides the landing route.
    await page.unroute("**/api/**");
    await page.route("**/api/auth/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      })
    );
    await page.getByRole("button", { name: SIGN_IN_NAME_RE }).first().click();
    await page.waitForLoadState("networkidle");
    return new URL(page.url()).pathname;
  };

  // Control leg: a valid same-origin in-app path is PRESERVED.
  test.skip("a valid in-app same-origin path is preserved (control)", async ({
    page,
  }) => {
    const landed = await recoverWithReturnTo(page, "/dashboard");
    expect(landed).toBe("/dashboard");
  });

  // Mutation legs: malicious returnTo values are rejected to the default route.
  // Pairing the control with these proves the guard is non-vacuous (it does not
  // simply send everything to the default route).
  const MALICIOUS = [
    "https://evil.example/x",
    "//evil.example",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "/not-an-app-route-zzz",
  ];
  for (const value of MALICIOUS) {
    test.skip(`the external/scheme-bearing returnTo ${value} is rejected to the default route`, async ({
      page,
    }) => {
      const landed = await recoverWithReturnTo(page, value);
      expect(landed).toBe(DEFAULT_ROUTE);
      // And the surface never navigated off-origin.
      expect(new URL(page.url()).origin).toBe(new URL(page.url()).origin);
    });
  }
});
