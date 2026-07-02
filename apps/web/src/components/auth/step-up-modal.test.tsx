import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { StepUpModal } from "./step-up-modal";

// The step-up modal is a SINGLE surface (modal depth 1, never a dialog over a
// dialog). Confirm re-authenticates; cancel (button OR Escape) aborts ONLY the
// action; a prior failure shows GENERIC, NON-NUMERIC copy (no countdown digits).

const DIGIT_RE = /\d/;
const CONFIRM_RE = /confirm/i;
const CANCEL_ACTION_RE = /cancel this action/i;

describe("the step-up modal is a single surface with a session-safe cancel", () => {
  test("it is exactly one role=dialog surface with aria-modal (never a dialog over a dialog)", () => {
    render(<StepUpModal />);
    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toHaveAttribute("aria-modal", "true");
  });

  test("confirm passes the re-entered credential to the handler", () => {
    const onConfirm = vi.fn();
    render(<StepUpModal onConfirm={onConfirm} />);
    fireEvent.change(screen.getByTestId("step-up-credential-input"), {
      target: { value: "secret-code" },
    });
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_RE }));
    expect(onConfirm).toHaveBeenCalledWith("secret-code");
  });

  test("the Cancel button aborts the action (calls onCancel)", () => {
    const onCancel = vi.fn();
    render(<StepUpModal onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: CANCEL_ACTION_RE }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("Escape cancels the action (a session-safe dismiss)", () => {
    const onCancel = vi.fn();
    render(<StepUpModal onCancel={onCancel} />);
    fireEvent.keyDown(screen.getAllByRole("dialog")[0], { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("on a prior failure the copy is generic and NON-NUMERIC (no countdown digits)", () => {
    render(<StepUpModal failed />);
    const alert = screen.getByTestId("step-up-error");
    expect(alert).toBeInTheDocument();
    expect(DIGIT_RE.test(alert.textContent ?? "")).toBe(false);
  });

  test("the credential input is a labelled field", () => {
    render(<StepUpModal />);
    const input = screen.getByTestId("step-up-credential-input");
    expect(input).toHaveAttribute("id");
    expect(input.id).toBeTruthy();
  });
});
