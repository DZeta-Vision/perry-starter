import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import SignInForm from "./sign-in-form";
import SignUpForm from "./sign-up-form";

// Both placeholder auth forms (rendered by the /login route) mount standalone —
// no router or auth context — with their labelled fields and a submit control,
// and crucially do NOT throw the Base UI "FieldRootContext is missing" error
// that a label part used outside a <Field.Root> raises. Regression guard for the
// /login render: a label that depends on a Field context would throw here.

const CREATE_ACCOUNT_RE = /create account/i;
const WELCOME_BACK_RE = /welcome back/i;
const NAME_RE = /name/i;
const EMAIL_RE = /email/i;
const SIGN_UP_RE = /sign up/i;
const SIGN_IN_RE = /sign in/i;

describe("the placeholder auth forms render standalone without a Field-context error", () => {
  test("the sign-up form renders name, email, and password fields with a submit", () => {
    render(<SignUpForm />);
    expect(
      screen.getByRole("heading", { name: CREATE_ACCOUNT_RE })
    ).toBeInTheDocument();
    expect(screen.getByLabelText(NAME_RE)).toBeInTheDocument();
    expect(screen.getByLabelText(EMAIL_RE)).toBeInTheDocument();
    // The promoted forms add a reveal toggle whose accessible name ("Show
    // password") also matches /password/i, so query the field by its exact label
    // to target the input (not the toggle).
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: SIGN_UP_RE })
    ).toBeInTheDocument();
  });

  test("the sign-in form renders email and password fields with a submit", () => {
    render(<SignInForm />);
    expect(
      screen.getByRole("heading", { name: WELCOME_BACK_RE })
    ).toBeInTheDocument();
    expect(screen.getByLabelText(EMAIL_RE)).toBeInTheDocument();
    // The promoted forms add a reveal toggle whose accessible name ("Show
    // password") also matches /password/i, so query the field by its exact label
    // to target the input (not the toggle).
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: SIGN_IN_RE })
    ).toBeInTheDocument();
  });
});
