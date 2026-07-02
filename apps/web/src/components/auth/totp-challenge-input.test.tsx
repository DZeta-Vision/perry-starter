import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { TotpChallengeInput } from "./totp-challenge-input";

const AUTHENTICATION_CODE_RE = /authentication code/i;

// WCAG 2.2 §3.3.8 (Accessible Authentication): the TOTP challenge input must be a
// single labelled field that PERMITS paste and carries `autocomplete="one-time-code"`
// + a numeric inputmode, so an authenticator/password manager can autofill it.

describe("the TOTP challenge input supports autofill and paste (WCAG 2.2 3.3.8)", () => {
  test("it carries autocomplete=one-time-code and a numeric inputmode", () => {
    render(<TotpChallengeInput />);
    const input = screen.getByTestId("totp-code-input");
    expect(input).toHaveAttribute("autocomplete", "one-time-code");
    expect(input).toHaveAttribute("inputmode", "numeric");
  });

  test("it is a labelled single field (never a per-digit split that blocks autofill)", () => {
    render(<TotpChallengeInput />);
    expect(screen.getByLabelText(AUTHENTICATION_CODE_RE)).toBeInTheDocument();
  });

  test("it PERMITS paste — a pasted code reaches the change handler intact", () => {
    let value = "";
    render(<TotpChallengeInput onValueChange={(next) => (value = next)} />);
    const input = screen.getByTestId("totp-code-input") as HTMLInputElement;
    // A paste that lands the full code fires change; nothing intercepts/strips it.
    fireEvent.change(input, { target: { value: "123456" } });
    expect(value).toBe("123456");
  });
});
