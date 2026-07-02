// Render tests for the GDPR erasure panel — the DOM behavior behind the erasure
// conformance gate: a destructive-confirm dialog gates the action (a SINGLE modal at
// a time — never a dialog stacked over another), a per-action step-up re-auth follows,
// the erasure-recorded confirmation is announced through a polite role="status"
// region, cancelling aborts ONLY the action (no logout), and the copy is locale-keyed.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { DataErasurePanel } from "@/components/settings/data-erasure-panel";
import { tDataRights } from "@/lib/data-rights-strings";

afterEach(() => cleanup());

const STEP_UP_CONFIRM_RE = /confirm and continue/i;
const STEP_UP_CANCEL_RE = /cancel this action/i;

// A seam that challenges on the first (grantless) call and completes once a step-up
// credential is presented — the real server contract (a prior grant never carries).
const challengeThenComplete = () =>
  vi.fn((stepUp?: { credential: string }) =>
    Promise.resolve(
      stepUp === undefined
        ? ({ status: "step-up-required" } as const)
        : ({ status: "done" } as const)
    )
  );

const openConfirm = (locale: "en" | "fr") =>
  fireEvent.click(
    screen.getByRole("button", {
      name: tDataRights(locale, "dataRights.erasure.action"),
    })
  );

test("the erasure action is a destructive trigger that opens a single confirm dialog", () => {
  render(<DataErasurePanel locale="en" onErase={challengeThenComplete()} />);
  // No dialog until the trigger is pressed.
  expect(screen.queryByRole("dialog")).toBeNull();
  openConfirm("en");
  // Exactly one modal is open (never a dialog over a dialog).
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(
    screen.getByText(tDataRights("en", "dataRights.erasure.confirmTitle"))
  ).toBeVisible();
});

test("confirming closes the confirm dialog and sequences into the step-up modal (still one modal)", async () => {
  const onErase = challengeThenComplete();
  render(<DataErasurePanel locale="en" onErase={onErase} />);
  openConfirm("en");
  fireEvent.click(
    screen.getByRole("button", {
      name: tDataRights("en", "dataRights.erasure.confirmCta"),
    })
  );
  // The first erasure call carried no step-up → the step-up modal is raised.
  await waitFor(() =>
    expect(screen.getByTestId("step-up-credential-input")).toBeVisible()
  );
  expect(onErase).toHaveBeenNthCalledWith(1, undefined);
  // Still a single modal (the confirm dialog closed before the step-up opened).
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});

test("a completed step-up records the erasure and announces it through a polite live region", async () => {
  const onErase = challengeThenComplete();
  render(<DataErasurePanel locale="en" onErase={onErase} />);
  openConfirm("en");
  fireEvent.click(
    screen.getByRole("button", {
      name: tDataRights("en", "dataRights.erasure.confirmCta"),
    })
  );
  await waitFor(() =>
    expect(screen.getByTestId("step-up-credential-input")).toBeVisible()
  );
  fireEvent.change(screen.getByTestId("step-up-credential-input"), {
    target: { value: "my-credential" },
  });
  fireEvent.click(screen.getByRole("button", { name: STEP_UP_CONFIRM_RE }));
  const status = screen.getByTestId("data-erasure-status");
  await waitFor(() =>
    expect(status).toHaveTextContent(
      tDataRights("en", "dataRights.erasure.requested")
    )
  );
  expect(status).toHaveAttribute("aria-live", "polite");
  // The resume presented the credential for THIS action.
  expect(onErase).toHaveBeenNthCalledWith(2, { credential: "my-credential" });
});

test("cancelling the confirm dialog aborts the action and never logs out", () => {
  const onErase = challengeThenComplete();
  render(<DataErasurePanel locale="en" onErase={onErase} />);
  openConfirm("en");
  fireEvent.click(
    screen.getByRole("button", {
      name: tDataRights("en", "dataRights.erasure.cancel"),
    })
  );
  // The dialog is gone and the erasure never fired — the action was aborted only.
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(onErase).not.toHaveBeenCalled();
});

test("cancelling the step-up aborts the action (no completion, no session effect)", async () => {
  const onErase = challengeThenComplete();
  render(<DataErasurePanel locale="en" onErase={onErase} />);
  openConfirm("en");
  fireEvent.click(
    screen.getByRole("button", {
      name: tDataRights("en", "dataRights.erasure.confirmCta"),
    })
  );
  await waitFor(() =>
    expect(screen.getByTestId("step-up-credential-input")).toBeVisible()
  );
  // Cancel the step-up — the action aborts, no second (completing) call is made.
  fireEvent.click(screen.getByRole("button", { name: STEP_UP_CANCEL_RE }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(onErase).toHaveBeenCalledTimes(1);
});

test("FR locale copy reaches the DOM (the FR string, not the EN fallback)", () => {
  render(<DataErasurePanel locale="fr" onErase={challengeThenComplete()} />);
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
    tDataRights("fr", "dataRights.erasure.heading")
  );
  expect(
    screen.getByRole("button", {
      name: tDataRights("fr", "dataRights.erasure.action"),
    })
  ).toBeVisible();
});
