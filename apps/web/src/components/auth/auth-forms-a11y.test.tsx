import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import SignInForm from "@/components/sign-in-form";
import SignUpForm from "@/components/sign-up-form";
import { useLocaleStore } from "@/lib/locale-store";

// The reliable (vitest + jsdom) leg for the WCAG-AA auth-form floor: centered
// max-w-md column, real label + non-echoed placeholder per input, a focusable
// reveal <button> with an accessible name + announced pressed state + ≥24px
// target that flips the input type, aria-invalid + aria-describedby inline errors
// with a polite live-region summary, a single primary action that disables while
// pending, generic anti-enumeration error copy, and the pre-auth theme + FR·EN
// text toggles with the no-truncation layout budget. (The per-route axe sweep is
// the operator-run Playwright/@axe-core leg.)

const PASSWORD_LABEL = "Password";
const SHOW_PASSWORD_RE = /show password/i;
const HIDE_PASSWORD_RE = /hide password/i;
const THEME_NAME_RE = /toggle theme|theme/i;
const LANGUAGE_NAME_RE = /language|langue/i;
const FR_TOKEN_RE = /\bFR\b/;
const EN_TOKEN_RE = /\bEN\b/;
const ENUMERATION_LEAK_RE =
  /not found|no account|already (registered|exists)|user exists|incorrect password|wrong password|not verified/i;
const TRUNCATION_RE = /\btruncate\b|\boverflow-hidden\b|\btext-ellipsis\b/;
const ORPHAN_RE = /orphan/i;
const SIGN_IN_RE = /sign in/i;
const RESET_SUBMIT_RE = /send|reset/i;
const FR_SUBMIT_RE = /se connecter/i;
const FR_FIELD_LABEL_RE = /mot de passe|adresse e-mail/i;
const MIN_TARGET_PX = 24;

const withTheme = (node: ReactNode): ReactNode => (
  <ThemeProvider attribute="class" defaultTheme="light">
    {node}
  </ThemeProvider>
);

beforeEach(() => {
  useLocaleStore.setState({ locale: "en" });
});
afterEach(() => {
  useLocaleStore.setState({ locale: "en" });
});

describe("the auth surfaces render in a centered max-w-md column", () => {
  test("each surface caps its column at max-w-md and centers it", () => {
    for (const node of [
      <SignInForm key="in" />,
      <SignUpForm key="up" />,
      <ResetPasswordForm key="reset" />,
      <ChangePasswordForm key="change" />,
    ]) {
      const { container, unmount } = render(withTheme(node));
      const column = container.querySelector(".mx-auto.max-w-md");
      expect(column).not.toBeNull();
      unmount();
    }
  });

  test("a full-bleed control container lacks the width cap (anti-vacuous)", () => {
    const { container } = render(
      <div className="w-full" data-test-fullbleed>
        bleed
      </div>
    );
    expect(
      container.querySelector("[data-test-fullbleed].max-w-md")
    ).toBeNull();
  });
});

describe("every input has a real label plus a meaningful, non-echoed placeholder", () => {
  test("the sign-in email + password inputs are reachable by label and carry a distinct placeholder", () => {
    render(withTheme(<SignInForm />));
    const email = screen.getByLabelText("Email");
    const placeholder = email.getAttribute("placeholder") ?? "";
    expect(placeholder.length).toBeGreaterThan(0);
    expect(placeholder.toLowerCase()).not.toBe("email");
    expect(screen.getByLabelText(PASSWORD_LABEL)).toBeInTheDocument();
  });

  test("the sign-up name/email/password inputs are all label-reachable", () => {
    render(withTheme(<SignUpForm />));
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText(PASSWORD_LABEL)).toBeInTheDocument();
  });

  test("a placeholder-only field is NOT reachable by a label (anti-vacuous)", () => {
    render(<input placeholder="orphan field" />);
    expect(screen.queryByLabelText(ORPHAN_RE)).toBeNull();
  });
});

describe("the password reveal toggle is an accessible, pressable button", () => {
  test("reveal is a real focusable button with a name, a ≥24px target, and flips pressed-state and input type", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(withTheme(<SignInForm />));

    const reveal = screen.getByRole("button", { name: SHOW_PASSWORD_RE });
    // A real <button>, not a div with a handler.
    expect(reveal.tagName).toBe("BUTTON");
    reveal.focus();
    expect(reveal).toHaveFocus();
    // ≥24px target (WCAG 2.5.8), guaranteed by an explicit min size.
    expect(Number.parseInt(reveal.style.minWidth, 10)).toBeGreaterThanOrEqual(
      MIN_TARGET_PX
    );
    expect(Number.parseInt(reveal.style.minHeight, 10)).toBeGreaterThanOrEqual(
      MIN_TARGET_PX
    );

    // Before activation: not pressed, masked.
    expect(reveal).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText(PASSWORD_LABEL)).toHaveAttribute(
      "type",
      "password"
    );

    // Activation flips BOTH the pressed-state and the input type.
    await user.click(reveal);
    const pressed = screen.getByRole("button", { name: HIDE_PASSWORD_RE });
    expect(pressed).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText(PASSWORD_LABEL)).toHaveAttribute(
      "type",
      "text"
    );
  });

  test("a decorative role=button div is NOT a real <button> (anti-vacuous)", () => {
    // Built via the DOM so the deliberately-wrong control carries role=button
    // without a real <button> element — the focusable-button contract it fails.
    const fake = document.createElement("div");
    fake.setAttribute("role", "button");
    expect(fake.getAttribute("role")).toBe("button");
    expect(fake.tagName).not.toBe("BUTTON");
  });
});

describe("inline errors are wired and announced politely", () => {
  test("an errored field sets aria-invalid + aria-describedby to a present error, summarized in a polite live region", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(withTheme(<SignInForm onSubmit={() => Promise.resolve()} />));

    const email = screen.getByLabelText("Email");
    // Control: with no error the field is not invalid and the live region empty.
    expect(email.getAttribute("aria-invalid")).not.toBe("true");
    const region = screen.getByRole("status");
    expect((region.textContent ?? "").trim()).toBe("");

    await user.type(email, "not-an-email");
    await user.click(screen.getByRole("button", { name: SIGN_IN_RE }));

    const erroredEmail = screen.getByLabelText("Email");
    expect(erroredEmail).toHaveAttribute("aria-invalid", "true");
    const describedBy = erroredEmail.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    // The described error element actually exists (no dangling id).
    expect(document.getElementById(describedBy ?? "")).not.toBeNull();
    expect(
      (screen.getByRole("status").textContent ?? "").length
    ).toBeGreaterThan(0);
  });
});

describe("submit disables while pending and there is a single primary action", () => {
  test("each surface exposes exactly one primary action", () => {
    for (const node of [
      <SignInForm key="in" />,
      <SignUpForm key="up" />,
      <ResetPasswordForm key="reset" />,
      <ChangePasswordForm key="change" />,
    ]) {
      const { container, unmount } = render(withTheme(node));
      expect(container.querySelectorAll('[data-primary="true"]')).toHaveLength(
        1
      );
      unmount();
    }
  });

  test("the primary submit is enabled at rest and disabled during a pending submission", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    let release: (() => void) | undefined;
    const onSubmit = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    render(withTheme(<SignInForm onSubmit={onSubmit} />));

    const submit = screen.getByRole("button", { name: SIGN_IN_RE });
    expect(submit).toBeEnabled();
    await user.type(screen.getByLabelText("Email"), "a@b.test");
    await user.type(screen.getByLabelText(PASSWORD_LABEL), "correct horse");
    await user.click(submit);
    expect(submit).toBeDisabled();

    release?.();
  });
});

describe("all auth error copy is generic (anti-enumeration)", () => {
  test("a registered and an unregistered email produce byte-identical, leak-free reset copy", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(withTheme(<ResetPasswordForm onSubmit={() => Promise.resolve()} />));
    const email = screen.getByLabelText("Email");
    const submit = screen.getByRole("button", { name: RESET_SUBMIT_RE });

    await user.type(email, "registered@b.test");
    await user.click(submit);
    const registered = (screen.getByRole("status").textContent ?? "").trim();

    await user.clear(email);
    await user.type(email, "nobody@b.test");
    await user.click(submit);
    const unregistered = (screen.getByRole("status").textContent ?? "").trim();

    expect(registered.length).toBeGreaterThan(0);
    expect(registered).toBe(unregistered);
    expect(registered).not.toMatch(ENUMERATION_LEAK_RE);
  });
});

describe("the pre-auth theme and FR·EN text toggles are present and never a flag", () => {
  test("the sign-in surface shows a theme toggle and an FR·EN text language toggle with no flag image", () => {
    render(withTheme(<SignInForm />));
    expect(
      screen.getByRole("button", { name: THEME_NAME_RE })
    ).toBeInTheDocument();
    const language = screen.getByRole("button", { name: LANGUAGE_NAME_RE });
    const text = language.textContent ?? "";
    expect(text).toMatch(FR_TOKEN_RE);
    expect(text).toMatch(EN_TOKEN_RE);
    expect(within(language).queryByRole("img")).toBeNull();
    expect(language.querySelector("img")).toBeNull();
  });

  test("under FR the fuller labels render in full and carry no truncating classes", () => {
    useLocaleStore.setState({ locale: "fr" });
    render(withTheme(<SignInForm />));
    // The FR submit copy renders in full (a +35%-longer string, not clipped).
    const submit = screen.getByRole("button", { name: FR_SUBMIT_RE });
    expect(submit.textContent).toContain("Se connecter");
    expect(submit.className).not.toMatch(TRUNCATION_RE);
    for (const label of screen.getAllByText(FR_FIELD_LABEL_RE)) {
      expect(label.className).not.toMatch(TRUNCATION_RE);
    }
  });

  test("a fixed-width truncating control is detected as clipping (anti-vacuous)", () => {
    render(
      <button className="w-10 truncate" type="button">
        Réinitialiser le mot de passe
      </button>
    );
    const clipped = screen.getByRole("button");
    expect(clipped.className).toMatch(TRUNCATION_RE);
  });
});
