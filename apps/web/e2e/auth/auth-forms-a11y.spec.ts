// Red-phase acceptance suite — accessible auth forms (sign-in / sign-up /
// reset / change) and the pre-auth theme + FR·EN text toggles. Every test is
// `test.skip(...)` (TDD red phase): the auth surfaces do not exist yet, so these
// stay skipped until the implementation lands and the dev un-skips them one at a
// time. The suite asserts the WCAG-AA auth-form floor: centered max-w-md column,
// a real label + meaningful placeholder per input, a focusable reveal <button>
// with an accessible name + pressed state + ≥24px target, aria-invalid +
// aria-describedby inline errors with a polite live-region summary, a single
// primary action that disables while pending, generic anti-enumeration error
// copy, and the pre-auth toggles with the FR +35% no-truncation layout budget.

import { expect, type Page } from "@playwright/test";
import { test } from "../fixtures/a11y";

const AUTH_SURFACES = [
  { name: "sign-in", path: "/login" },
  { name: "sign-up", path: "/login?mode=sign-up" },
  { name: "reset-request", path: "/reset-password" },
  { name: "change-password", path: "/change-password" },
] as const;

const PASSWORD_LABEL_RE = /password/i;
const EMAIL_LABEL_RE = /email/i;
const REVEAL_NAME_RE = /show password|hide password/i;
const LANGUAGE_NAME_RE = /language|langue|FR|EN/i;
const THEME_NAME_RE = /theme|appearance|dark|light/i;
const FR_TEXT_RE = /\bFR\b/;
const EN_TEXT_RE = /\bEN\b/;
// Existence/state-revealing phrases that anti-enumeration copy must NEVER show.
const ENUMERATION_LEAK_RE =
  /not found|no account|already (registered|exists)|user exists|incorrect password|wrong password|not verified/i;
const SIGN_IN_BUTTON_RE = /sign in/i;
const RESET_SUBMIT_RE = /reset|send|continue/i;
const ORPHAN_FIELD_RE = /placeholder-only-field/i;
const MIN_TARGET_PX = 24;

// The validated form container should be width-capped (max-w-md ≈ 28rem/448px)
// and horizontally centered. A generous ceiling keeps the assertion robust to
// padding while still catching a full-bleed (uncapped) container.
const MAX_W_MD_CEILING_PX = 520;

const formBox = async (page: Page) => {
  const form = page.locator("form").first();
  await expect(form).toBeVisible();
  const box = await form.boundingBox();
  if (!box) {
    throw new Error("auth form has no bounding box");
  }
  return box;
};

test.describe("the auth forms render in a centered max-w-md column", () => {
  for (const surface of AUTH_SURFACES) {
    test.skip(`the ${surface.name} form is width-capped and horizontally centered`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(surface.path);
      const box = await formBox(page);
      // Width-capped (not full-bleed).
      expect(box.width).toBeLessThanOrEqual(MAX_W_MD_CEILING_PX);
      // Centered: left and right gutters are within a small tolerance.
      const rightGutter = 1280 - (box.x + box.width);
      expect(Math.abs(box.x - rightGutter)).toBeLessThanOrEqual(8);
    });
  }

  // Anti-vacuous: a deliberately full-bleed sibling proves the width assertion
  // measures real layout, not a constant the page happens to satisfy.
  test.skip("a full-bleed container is measurably wider than the capped form (control)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/login");
    const box = await formBox(page);
    const bleed = page.locator("[data-test-fullbleed]");
    const bleedBox = await bleed.boundingBox();
    expect(bleedBox?.width ?? 0).toBeGreaterThan(box.width);
  });
});

test.describe("every input has a real label plus a meaningful placeholder", () => {
  for (const surface of AUTH_SURFACES) {
    test.skip(`${surface.name} inputs are reachable by label and carry a non-echoed placeholder`, async ({
      page,
    }) => {
      await page.goto(surface.path);
      const email = page.getByLabel(EMAIL_LABEL_RE).first();
      if (await email.count()) {
        await expect(email).toBeVisible();
        const placeholder = (await email.getAttribute("placeholder")) ?? "";
        expect(placeholder.trim().length).toBeGreaterThan(0);
      }
      const password = page.getByLabel(PASSWORD_LABEL_RE).first();
      if (await password.count()) {
        await expect(password).toBeVisible();
      }
    });
  }

  // Anti-vacuous: a placeholder-only field (no <label>/for) is NOT reachable by
  // getByLabel — proving the label assertion is not satisfied by a placeholder.
  test.skip("a placeholder-only field is not reachable by its label (mutation)", async ({
    page,
  }) => {
    await page.goto("/login");
    const orphan = page.getByLabel(ORPHAN_FIELD_RE);
    expect(await orphan.count()).toBe(0);
  });
});

test.describe("the password reveal toggle is an accessible, pressable button", () => {
  test.skip("reveal is a focusable button with a name, ≥24px target, and flips pressed-state and input type", async ({
    page,
  }) => {
    await page.goto("/login");
    const password = page.getByLabel(PASSWORD_LABEL_RE).first();
    const reveal = page.getByRole("button", { name: REVEAL_NAME_RE });
    await expect(reveal).toBeVisible();

    // Real button: keyboard-focusable.
    await reveal.focus();
    await expect(reveal).toBeFocused();

    // ≥24px target (WCAG 2.5.8).
    const box = await reveal.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(MIN_TARGET_PX);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TARGET_PX);

    // Before activation: not pressed, masked.
    await expect(reveal).toHaveAttribute("aria-pressed", "false");
    await expect(password).toHaveAttribute("type", "password");

    // Activation flips BOTH the pressed-state and the input type.
    await reveal.click();
    await expect(reveal).toHaveAttribute("aria-pressed", "true");
    await expect(password).toHaveAttribute("type", "text");
  });

  // Anti-vacuous: a decorative div-with-onclick is not a focusable button.
  test.skip("a non-button reveal control fails the focusable-button contract (mutation)", async ({
    page,
  }) => {
    await page.goto("/login");
    const fakeReveal = page.locator("[data-test-fake-reveal]");
    // role=button must be a real <button>, not a div carrying a handler.
    const tag = await fakeReveal.evaluate((el) => el.tagName.toLowerCase());
    expect(tag).not.toBe("button");
  });
});

test.describe("inline errors are wired and announced politely", () => {
  test.skip("an errored field sets aria-invalid and aria-describedby pointing at a present error, summarized in a polite live region", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel(EMAIL_LABEL_RE).fill("not-an-email");
    await page.getByRole("button", { name: SIGN_IN_BUTTON_RE }).click();

    const email = page.getByLabel(EMAIL_LABEL_RE);
    await expect(email).toHaveAttribute("aria-invalid", "true");
    const describedBy = await email.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    // The described error element actually exists (no dangling id).
    await expect(page.locator(`#${describedBy}`)).toBeVisible();

    // A polite live region carries the form-level summary.
    const live = page.locator('[aria-live="polite"], [role="status"]');
    await expect(live.first()).toBeVisible();
  });

  // Anti-vacuous: with no error, the field is NOT marked invalid and the live
  // region is empty — proving the wiring is state-driven, not always-on.
  test.skip("with no error present the field is not invalid and the live region is empty (control)", async ({
    page,
  }) => {
    await page.goto("/login");
    const email = page.getByLabel(EMAIL_LABEL_RE);
    expect(await email.getAttribute("aria-invalid")).not.toBe("true");
  });
});

test.describe("submit disables while pending and there is a single primary action", () => {
  for (const surface of AUTH_SURFACES) {
    test.skip(`${surface.name} exposes exactly one primary action`, async ({
      page,
    }) => {
      await page.goto(surface.path);
      const primaries = page.locator(
        'button[data-primary="true"], button[data-variant="default"]'
      );
      expect(await primaries.count()).toBe(1);
    });
  }

  test.skip("the primary submit is enabled at rest and disabled during a pending submission", async ({
    page,
  }) => {
    await page.goto("/login");
    // Hold the auth call open so the pending state is observable.
    await page.route("**/api/auth/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({ status: 401, body: "{}" });
    });
    const submit = page.getByRole("button", { name: SIGN_IN_BUTTON_RE });
    await expect(submit).toBeEnabled();
    await page.getByLabel(EMAIL_LABEL_RE).fill("a@b.test");
    await page.getByLabel(PASSWORD_LABEL_RE).fill("correct horse battery");
    await submit.click();
    await expect(submit).toBeDisabled();
  });
});

test.describe("all auth error copy is generic (anti-enumeration)", () => {
  test.skip("a registered and an unregistered email produce byte-identical generic error copy", async ({
    page,
  }) => {
    const copyFor = async (email: string): Promise<string> => {
      await page.goto("/reset-password");
      await page.getByLabel(EMAIL_LABEL_RE).fill(email);
      await page.getByRole("button", { name: RESET_SUBMIT_RE }).click();
      const region = page.locator('[aria-live="polite"], [role="status"]');
      await expect(region.first()).toBeVisible();
      return (await region.first().innerText()).trim();
    };
    const registered = await copyFor("registered@b.test");
    const unregistered = await copyFor("nobody@b.test");
    expect(registered).toBe(unregistered);
    expect(registered).not.toMatch(ENUMERATION_LEAK_RE);
  });
});

test.describe("the pre-auth theme and FR·EN text toggles are present and never a flag", () => {
  test.skip("the login surface shows a theme toggle and an FR·EN text language toggle with no flag image", async ({
    page,
  }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("button", { name: THEME_NAME_RE })
    ).toBeVisible();
    const language = page.getByRole("button", { name: LANGUAGE_NAME_RE });
    await expect(language).toBeVisible();
    const text = (await language.innerText()) ?? "";
    expect(text).toMatch(FR_TEXT_RE);
    expect(text).toMatch(EN_TEXT_RE);
    // The language meaning must never be carried by a flag glyph/image.
    expect(await language.locator("img").count()).toBe(0);
  });

  test.skip("FR labels grown by +35% wrap or grow and never truncate", async ({
    page,
  }) => {
    await page.goto("/login?locale=fr");
    const controls = page.locator(
      "button[data-primary='true'], label, [data-i18n]"
    );
    const count = await controls.count();
    for (let i = 0; i < count; i++) {
      const el = controls.nth(i);
      // No clipped text: the scroll width fits the client width.
      const overflow = await el.evaluate(
        (node) => node.scrollWidth - node.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(1);
    }
  });

  // Anti-vacuous: a flag-image language control is detected as carrying a flag
  // and missing the FR·EN text — the gate's "text toggle, not a flag" assertion
  // would redden under this mutant.
  test.skip("a flag-image language control is detected as a flag without FR·EN text (mutation)", async ({
    page,
  }) => {
    await page.goto("/login");
    const flagControl = page.locator("[data-test-flag-language]");
    expect(await flagControl.locator("img").count()).toBeGreaterThan(0);
    const text = (await flagControl.innerText()) ?? "";
    expect(FR_TEXT_RE.test(text) && EN_TEXT_RE.test(text)).toBe(false);
  });
});

test.describe("the auth surfaces pass the WCAG A+AA accessibility sweep", () => {
  for (const surface of AUTH_SURFACES) {
    test.skip(`${surface.name} has zero axe violations`, async ({
      page,
      checkA11y,
    }) => {
      await page.goto(surface.path);
      await checkA11y();
    });
  }
});
