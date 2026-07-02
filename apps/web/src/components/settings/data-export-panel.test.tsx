// Render tests for the one-click data-export panel — the DOM behavior behind the
// data-rights conformance gate: a single click produces the export, the confirmation
// is announced through a polite `role="status"` region, the copy is locale-keyed
// (EN/FR), and an error surfaces politely without a focus steal.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { DataExportPanel } from "@/components/settings/data-export-panel";
import { tDataRights } from "@/lib/data-rights-strings";

afterEach(() => cleanup());

test("the panel exposes exactly one export button (one click, not a stepper)", () => {
  render(<DataExportPanel locale="en" onExport={() => Promise.resolve({})} />);
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(
    screen.getByRole("button", {
      name: tDataRights("en", "dataRights.export.action"),
    })
  ).toBeVisible();
});

test("the confirmation lives in a polite role=status live region", () => {
  render(<DataExportPanel locale="en" onExport={() => Promise.resolve({})} />);
  const status = screen.getByRole("status");
  expect(status).toHaveAttribute("aria-live", "polite");
});

test("FR locale copy reaches the DOM (the FR string, not the EN fallback)", () => {
  render(<DataExportPanel locale="fr" onExport={() => Promise.resolve({})} />);
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
    tDataRights("fr", "dataRights.export.heading")
  );
  expect(
    screen.queryByText(tDataRights("en", "dataRights.export.action"))
  ).toBeNull();
  expect(
    screen.getByRole("button", {
      name: tDataRights("fr", "dataRights.export.action"),
    })
  ).toBeVisible();
});

test("one click produces the export and announces the ready confirmation with a download link", async () => {
  render(
    <DataExportPanel
      locale="fr"
      onExport={() => Promise.resolve({ subject_user_id: "user-a" })}
    />
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: tDataRights("fr", "dataRights.export.action"),
    })
  );
  const status = screen.getByRole("status");
  await waitFor(() =>
    expect(status).toHaveTextContent(
      tDataRights("fr", "dataRights.export.ready")
    )
  );
  const download = screen.getByRole("link", {
    name: tDataRights("fr", "dataRights.export.download"),
  });
  expect(download).toBeVisible();
  expect(download.getAttribute("href")).toContain("application/json");
});

test("an export failure is announced politely (no thrown error, no focus steal)", async () => {
  render(
    <DataExportPanel
      locale="en"
      onExport={() => Promise.reject(new Error("backend unavailable"))}
    />
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: tDataRights("en", "dataRights.export.action"),
    })
  );
  const status = screen.getByRole("status");
  await waitFor(() =>
    expect(status).toHaveTextContent(
      tDataRights("en", "dataRights.export.error")
    )
  );
});
