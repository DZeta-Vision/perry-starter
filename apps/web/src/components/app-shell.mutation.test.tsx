// Mutation twin for the app-shell render gate. Each render assertion is
// replicated against a deliberately-wrong inline fixture that asserts the bad
// property IS observable (so the gate would redden), with a clean control:
//   (1) a language control rendered as a flag image (no `FR · EN` text) → the
//       "text-toggle, not a flag" assertion flips.
//   (2) a theme toggle with no accessible name → the a11y-name assertion flips.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";

const FR_TOKEN_RE = /\bFR\b/;
const EN_TOKEN_RE = /\bEN\b/;
const THEME_NAME_RE = /theme|appearance|dark|light/i;

// Mutant: the language affordance carries a flag glyph, not the `FR · EN` text.
// A non-empty alt keeps role="img" so the gate's "no flag" assertion can find it.
const LanguageToggleAsFlag = () => (
  <button type="button">
    <img alt="Français" height={11} src="/fr.svg" width={16} />
  </button>
);

// Mutant: a theme toggle with no accessible name (no label, no text).
const NamelessThemeToggle = () => <button type="button" />;

// Control: a correctly-named theme toggle.
const NamedThemeToggle = () => (
  <button aria-label="Toggle theme" type="button" />
);

describe("the language-toggle render assertion flips on a flag-image control", () => {
  test("a flag-image language control is detected as carrying a flag and missing the FR·EN text", () => {
    render(<LanguageToggleAsFlag />);
    const control = screen.getByRole("button");
    // The banned flag is present...
    expect(within(control).queryByRole("img")).not.toBeNull();
    // ...and the required `FR · EN` text is absent → the gate's text-toggle
    // assertion would fail under this mutant.
    const text = control.textContent ?? "";
    expect(FR_TOKEN_RE.test(text) && EN_TOKEN_RE.test(text)).toBe(false);
  });
});

describe("the theme-toggle a11y-name assertion flips on a nameless control", () => {
  test("a nameless theme toggle is detected as having no accessible name", () => {
    render(<NamelessThemeToggle />);
    const control = screen.getByRole("button");
    const accessibleName =
      control.getAttribute("aria-label") ?? control.textContent ?? "";
    expect(THEME_NAME_RE.test(accessibleName)).toBe(false);
  });

  test("a correctly-named theme toggle stays green (not always-firing)", () => {
    render(<NamedThemeToggle />);
    const control = screen.getByRole("button", { name: THEME_NAME_RE });
    expect(control).toBeInTheDocument();
  });
});
