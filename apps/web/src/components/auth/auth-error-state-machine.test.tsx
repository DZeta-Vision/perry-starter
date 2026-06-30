import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { AuthErrorSurface } from "@/components/auth/auth-error-surface";
import { AUTH_ERROR_CODES } from "@/lib/auth-error";
import { useLocaleStore } from "@/lib/locale-store";

// Sonner's toast is mocked (vitest hoists vi.mock above the imports) so the
// SESSION_EXPIRED treatment's announcement is observable without a Toaster.
vi.mock("sonner", () => ({ toast: vi.fn() }));

// The reliable (vitest + jsdom) leg for the 8-state AuthErrorResponse machine:
// each server code resolves to exactly one treatment surface, the eight surfaces
// are mutually distinct, the forced-change gate is non-dismissable and not a
// keyboard-trap dead-end, the D6 placeholders are reachable with a forward path
// and never stack a dialog over a dialog, the locked surface shows a Turnstile
// container with no numeric countdown, and SESSION_EXPIRED preserves only an
// allowlist-validated returnTo. (End-to-end navigation is the operator Playwright
// leg; the TOTP/step-up transitions land in Epic 5.)

const COUNTDOWN_DIGITS_RE = /\b\d+\s*(seconds?|minutes?|s|min)\b/i;
const NO_ACCESS_RE = /no access|don.t have access|forbidden|not allowed/i;
const FORWARD_PATH_RE = /back to sign|cancel|continue|sign in|return/i;
const SIGN_IN_RE = /sign in/i;
const RESEND_RE = /resend/i;
const CLOSE_RE = /close/i;
const UPDATE_PASSWORD_RE = /update password/i;

const withTheme = (node: ReactNode): ReactNode => (
  <ThemeProvider attribute="class" defaultTheme="light">
    {node}
  </ThemeProvider>
);

const treatmentMarker = (container: HTMLElement): string | null =>
  container
    .querySelector("[data-auth-treatment]")
    ?.getAttribute("data-auth-treatment") ?? null;

beforeEach(() => {
  useLocaleStore.setState({ locale: "en" });
  vi.mocked(toast).mockClear();
});

describe("each AuthErrorResponse code maps to exactly one treatment", () => {
  test("UNAUTHORIZED resolves to the generic sign-in surface", () => {
    const { container } = render(
      withTheme(<AuthErrorSurface code="UNAUTHORIZED" />)
    );
    expect(treatmentMarker(container)).toBe("sign-in");
    expect(
      screen.getByRole("button", { name: SIGN_IN_RE })
    ).toBeInTheDocument();
  });

  test("SESSION_EXPIRED announces via a toast and resolves to the sign-in surface", () => {
    const { container } = render(
      withTheme(
        <AuthErrorSurface code="SESSION_EXPIRED" returnTo="/dashboard" />
      )
    );
    expect(treatmentMarker(container)).toBe("session-expired");
    expect(toast).toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: SIGN_IN_RE })
    ).toBeInTheDocument();
  });

  test("EMAIL_NOT_VERIFIED resolves to the verification wall with a non-numeric resend", () => {
    const { container } = render(
      withTheme(<AuthErrorSurface code="EMAIL_NOT_VERIFIED" />)
    );
    expect(treatmentMarker(container)).toBe("verify-email");
    expect(screen.getByRole("button", { name: RESEND_RE })).toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(COUNTDOWN_DIGITS_RE);
  });

  test("PASSWORD_CHANGE_REQUIRED resolves to a non-dismissable forced-change dialog", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { container } = render(
      withTheme(<AuthErrorSurface code="PASSWORD_CHANGE_REQUIRED" />)
    );
    expect(treatmentMarker(container)).toBe("forced-password-change");
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();

    // No dismiss affordance.
    expect(within(dialog).queryByRole("button", { name: CLOSE_RE })).toBeNull();
    // Escape does not close it.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Clicking the backdrop does not close it.
    const backdrop = container.querySelector(".fixed.inset-0");
    if (backdrop) {
      await user.click(backdrop);
    }
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // It always offers a forward path (set a new password) — not a dead-end.
    expect(
      within(dialog).getByRole("button", { name: UPDATE_PASSWORD_RE })
    ).toBeInTheDocument();
  });

  test("TWO_FACTOR_REQUIRED resolves to a defined placeholder with a forward path", () => {
    const { container } = render(
      withTheme(<AuthErrorSurface code="TWO_FACTOR_REQUIRED" />)
    );
    expect(treatmentMarker(container)).toBe("two-factor");
    expect(
      screen.getByRole("button", { name: FORWARD_PATH_RE })
    ).toBeInTheDocument();
  });

  test("STEP_UP_REQUIRED resolves to a single placeholder surface with a forward path (never a dialog over a dialog)", () => {
    const { container } = render(
      withTheme(<AuthErrorSurface code="STEP_UP_REQUIRED" />)
    );
    expect(treatmentMarker(container)).toBe("step-up");
    expect(
      screen.getByRole("button", { name: FORWARD_PATH_RE })
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("dialog").length).toBeLessThanOrEqual(1);
  });

  test("ACCOUNT_LOCKED resolves to the locked surface with a Turnstile container and no numeric countdown", () => {
    const { container } = render(
      withTheme(<AuthErrorSurface code="ACCOUNT_LOCKED" />)
    );
    expect(treatmentMarker(container)).toBe("account-locked");
    expect(container.querySelector("[data-turnstile]")).not.toBeNull();
    expect(container.textContent ?? "").not.toMatch(COUNTDOWN_DIGITS_RE);
  });

  test("FORBIDDEN resolves to a generic no-access surface", () => {
    const { container } = render(
      withTheme(<AuthErrorSurface code="FORBIDDEN" />)
    );
    expect(treatmentMarker(container)).toBe("no-access");
    expect(container.textContent ?? "").toMatch(NO_ACCESS_RE);
  });

  test("the eight codes resolve to eight distinct, well-defined treatments (coverage map)", () => {
    const markers = new Set<string>();
    for (const code of AUTH_ERROR_CODES) {
      const { container, unmount } = render(
        withTheme(<AuthErrorSurface code={code} returnTo="/dashboard" />)
      );
      const marker = treatmentMarker(container);
      expect(
        marker,
        `code ${code} must map to a defined treatment`
      ).toBeTruthy();
      markers.add(marker ?? "");
      unmount();
    }
    expect(markers.size).toBe(AUTH_ERROR_CODES.length);
  });
});

describe("the SESSION_EXPIRED returnTo is validated against the same-origin allowlist", () => {
  test("a valid in-app path is preserved as the recovery destination (control)", () => {
    const { container } = render(
      withTheme(
        <AuthErrorSurface code="SESSION_EXPIRED" returnTo="/dashboard" />
      )
    );
    expect(
      container
        .querySelector("[data-return-to]")
        ?.getAttribute("data-return-to")
    ).toBe("/dashboard");
  });

  test("an off-origin returnTo is rejected to the default route", () => {
    const { container } = render(
      withTheme(
        <AuthErrorSurface
          code="SESSION_EXPIRED"
          returnTo="https://evil.example/x"
        />
      )
    );
    expect(
      container
        .querySelector("[data-return-to]")
        ?.getAttribute("data-return-to")
    ).toBe("/");
  });
});
