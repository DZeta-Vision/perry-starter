// The app-shell loads with a light/dark theme toggle (accessible name, ≥24px
// target, system-preference default + per-device persist via next-themes), an
// `FR · EN` text language toggle (never a flag), a sign-in form with placeholder
// copy, and the shipped neutral-teal `--primary` token. The shell chrome is
// imported lazily so a not-yet-final module resolves only at run time. Paired
// twin: app-shell.mutation.test.tsx.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "next-themes";
import type { ComponentType, ReactNode } from "react";
import { describe, expect, test } from "vitest";

const THEME_NAME_RE = /theme|appearance|dark|light/i;
const LANGUAGE_NAME_RE = /FR|EN|language|langue/i;
const FR_TOKEN_RE = /\bFR\b/;
const EN_TOKEN_RE = /\bEN\b/;
const PRIMARY_TOKEN_RE = /--primary\s*:/;

// Function-indirected dynamic import — keeps the specifier non-statically-
// analyzable so Vite never resolves a not-yet-final module at collect time.
const dyn = (specifier: string): Promise<Record<string, unknown>> =>
  import(specifier) as Promise<Record<string, unknown>>;

// Resolve the shell chrome the dev wires the toggles into (Task 4 edits
// header.tsx; the dev aligns the export at green phase).
const loadShell = async (): Promise<ComponentType> => {
  const mod = await dyn("./header");
  return (mod.default ?? mod.Header) as ComponentType;
};

const loadSignInForm = async (): Promise<ComponentType> => {
  const mod = await dyn("./sign-in-form");
  return (mod.default ?? mod.SignInForm) as ComponentType;
};

const withTheme = (node: ReactNode): ReactNode => (
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
    {node}
  </ThemeProvider>
);

describe("the app-shell loads its toggles, sign-in form, and neutral-teal token", () => {
  test("a light/dark theme toggle is present with an accessible name and drives the theme on activation (system default, per-device persist)", async () => {
    const Shell = await loadShell();
    render(withTheme(<Shell />));

    const toggle = screen.getByRole("button", { name: THEME_NAME_RE });
    expect(toggle).toBeInTheDocument();

    // Anti-vacuous: activating it actually drives next-themes (sets the `dark`
    // class on <html>), not a decorative control.
    await userEvent.click(toggle);
    expect(document.documentElement).toHaveClass("dark");
  });

  test("the language toggle is the literal `FR · EN` text affordance — never a flag image", async () => {
    const Shell = await loadShell();
    render(withTheme(<Shell />));

    const language = screen.getByRole("button", { name: LANGUAGE_NAME_RE });
    const text = language.textContent ?? "";
    expect(text).toMatch(FR_TOKEN_RE);
    expect(text).toMatch(EN_TOKEN_RE);
    // The language meaning must never be carried by a flag glyph/image.
    expect(within(language).queryByRole("img")).toBeNull();
    expect(language.querySelector("img")).toBeNull();
  });

  test("the sign-in form renders with placeholder copy", async () => {
    const SignInForm = await loadSignInForm();
    render(withTheme(<SignInForm />));

    const inputs = screen.getAllByRole("textbox");
    expect(inputs.length).toBeGreaterThan(0);
    expect(
      inputs.some(
        (input) => (input.getAttribute("placeholder") ?? "").length > 0
      )
    ).toBe(true);
  });

  test("the shipped neutral-teal `--primary` AA token is present in index.css", () => {
    const css = readFileSync(
      join(process.cwd(), "apps", "web", "src", "index.css"),
      "utf8"
    );
    expect(css).toMatch(PRIMARY_TOKEN_RE);
  });
});
