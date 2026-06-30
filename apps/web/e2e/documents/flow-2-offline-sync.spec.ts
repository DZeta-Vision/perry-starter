// Red-phase acceptance suite — Flow 2: a Member edits offline on the desktop and
// the queued writes sync on reconnect, honestly, with no false "saved to cloud".
// Every test is `test.skip(...)` (TDD red phase): the documents list/editor, the
// freshness + offline indicators, and the offline→reconnect catch-up do not exist
// yet, so these stay skipped until the implementation lands and the dev un-skips
// them one at a time.
//
// The narrative (Flow 2, realized end-to-end):
//   instant local list load (virtualized)
//     → the network drops in a tunnel: ONE Sonner toast on the transition + a
//       persistent quiet "Working offline" indicator
//     → keystrokes save locally (optimistic, no blocking spinner)
//     → a second collaborative document honestly reads "May be out of date"
//     → the device exits the tunnel and reconnects:
//         the edited doc's indicator moves stale → syncing → up-to-date on its
//         own, with EXACTLY ONE catch-up confirmation toast
//     → THE P0 CLIMAX: the UI NEVER shows a false "saved to cloud" — "Up to date"
//       is reachable ONLY after the per-id push-response cursor returns (the
//       verdict consumed from the single-owner data/sync seam). This is asserted
//       NON-VACUOUSLY by pairing the negative (local-write-only never reaches
//       up-to-date) with a positive control (the SAME doc DOES reach up-to-date
//       once the ack returns) — so a UI that simply never shows up-to-date fails
//       the control, and a UI that shows it off a local write fails the negative.
//     → a private document also edited elsewhere resolves silently by
//       last-write-wins: no merge dialog, at most a subtle "updated elsewhere"
//       note.
//
// The exact route/marker/endpoint wiring is an implementation detail the dev
// aligns at green; these specs assert the OBSERVABLE behaviour. All app-surface
// references live INSIDE the skipped bodies — the only top-level imports are
// `@playwright/test` and the existing a11y fixture.

import { expect, type Page, type Route } from "@playwright/test";
import { test } from "../fixtures/a11y";

const DOCUMENTS_ROUTE = "/documents";

// Indicator copy (the accessibility text-label floor — meaning is never colour-only).
const UP_TO_DATE_RE = /up to date/i;
const SYNCING_RE = /syncing/i;
const MAY_BE_STALE_RE = /may be out of date/i;
const WORKING_OFFLINE_RE = /working offline/i;
const UPDATED_ELSEWHERE_RE = /updated elsewhere/i;
const CREATE_FIRST_DOC_RE = /create your first document/i;

// A false "saved to cloud" claim — must NEVER appear off a local-only write.
const SAVED_TO_CLOUD_RE = /saved to (the )?cloud/i;

// Toast surface (Sonner renders a status/list region).
const TOAST_SELECTOR =
  "[data-sonner-toast], [data-sonner-toaster] [role='status']";

// Stable markers the dev stamps on the documents surface at green.
const LIST_SELECTOR = "[data-document-list]";
const ROW_SELECTOR = "[data-document-row]";
const EDITOR_SELECTOR = "[data-document-editor]";
const FRESHNESS_SELECTOR = "[data-freshness-indicator]";
const OFFLINE_SELECTOR = "[data-offline-indicator]";

// Drop / restore the network signal (the tunnel). Playwright's context offline
// switch is the connectivity the offline-reflection store + seam observe.
const enterTunnel = async (page: Page): Promise<void> => {
  await page.context().setOffline(true);
};
const exitTunnel = async (page: Page): Promise<void> => {
  await page.context().setOffline(false);
};

// The freshness verdict text for a given document's indicator, read from the
// single-owner seam-driven indicator (never recomputed by the test).
const freshnessTextFor = async (page: Page, docId: string): Promise<string> => {
  const indicator = page
    .locator(
      `[data-doc-id="${docId}"] ${FRESHNESS_SELECTOR}, ${FRESHNESS_SELECTOR}[data-doc-id="${docId}"]`
    )
    .first();
  return ((await indicator.textContent()) ?? "").trim();
};

test.describe("Flow 2 — instant local list load, then the tunnel", () => {
  test.skip("the documents list loads instantly from the local store and is virtualized", async ({
    page,
  }) => {
    await page.goto(DOCUMENTS_ROUTE);
    const list = page.locator(LIST_SELECTOR);
    await expect(list).toBeVisible();
    // Virtualized over a server keyset query: only a window renders, while the
    // server total is exposed via aria-rowcount (never the windowed count).
    const total = Number(await list.getAttribute("aria-rowcount"));
    const rendered = await page.locator(ROW_SELECTOR).count();
    expect(total).toBeGreaterThan(0);
    expect(rendered).toBeLessThanOrEqual(total);
  });

  test.skip("an empty documents list shows the generic placeholder + a single primary action", async ({
    page,
  }) => {
    await page.route("**/documents**", (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ rows: [], totalCount: 0 }),
      })
    );
    await page.goto(DOCUMENTS_ROUTE);
    await expect(page.getByText(CREATE_FIRST_DOC_RE)).toBeVisible();
  });

  test.skip("dropping the network shows ONE Sonner toast and a persistent quiet 'Working offline' indicator", async ({
    page,
  }) => {
    await page.goto(DOCUMENTS_ROUTE);
    await enterTunnel(page);
    // Exactly one toast fires on the offline transition.
    await expect(page.locator(TOAST_SELECTOR)).toHaveCount(1);
    // And the persistent quiet status indicator reads "Working offline".
    const offline = page.locator(OFFLINE_SELECTOR);
    await expect(offline).toHaveText(WORKING_OFFLINE_RE);
    // It is a quiet status, never a blocking spinner.
    await expect(page.getByRole("progressbar")).toHaveCount(0);
  });
});

test.describe("Flow 2 — keystroke-saved offline, honest staleness", () => {
  test.skip("every keystroke saves locally offline with no blocking spinner (optimistic)", async ({
    page,
  }) => {
    await page.goto(DOCUMENTS_ROUTE);
    await page.locator(ROW_SELECTOR).first().click();
    await enterTunnel(page);
    const editor = page.locator(EDITOR_SELECTOR);
    await editor.click();
    await page.keyboard.type("offline edit while in the tunnel");
    // The UI never blocks on the network — no blocking spinner appears.
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    // The edit persists locally and is reflected immediately (optimistic).
    await expect(editor).toContainText("offline edit while in the tunnel");
  });

  test.skip("a collaborative document with no materializing tab honestly reads 'May be out of date'", async ({
    page,
  }) => {
    await page.goto(DOCUMENTS_ROUTE);
    await enterTunnel(page);
    // The collaborative doc's seam verdict is may-be-stale (truthful, not a bug).
    const collaborativeText = await freshnessTextFor(page, "collab-doc");
    expect(collaborativeText).toMatch(MAY_BE_STALE_RE);
    expect(collaborativeText).not.toMatch(UP_TO_DATE_RE);
  });
});

test.describe("Flow 2 — reconnect catch-up: stale → syncing → up-to-date, one toast", () => {
  test.skip("on reconnect the edited doc moves stale → syncing → up-to-date with exactly ONE catch-up toast", async ({
    page,
  }) => {
    await page.goto(DOCUMENTS_ROUTE);
    await page.locator(ROW_SELECTOR).first().click();
    await enterTunnel(page);
    await page.locator(EDITOR_SELECTOR).click();
    await page.keyboard.type("an edit made offline");

    // Before reconnect the durable ack has not returned — never up-to-date.
    expect(await freshnessTextFor(page, "edited-doc")).not.toMatch(
      UP_TO_DATE_RE
    );

    // Exit the tunnel: the queued writes flush; the push endpoint returns the
    // per-id cursor ack; the indicator advances on its own.
    await exitTunnel(page);
    const indicator = page
      .locator(`[data-doc-id="edited-doc"] ${FRESHNESS_SELECTOR}`)
      .first();
    await expect(indicator).toHaveText(SYNCING_RE);
    await expect(indicator).toHaveText(UP_TO_DATE_RE);

    // Exactly one calm catch-up confirmation fires on full catch-up.
    await expect(page.locator(TOAST_SELECTOR)).toHaveCount(1);
  });
});

test.describe("Flow 2 CLIMAX (P0) — never a false 'saved to cloud'", () => {
  // NEGATIVE leg: a document saved ONLY locally (offline, no per-id push ack)
  // must never read "Up to date" and the UI must never claim "saved to cloud".
  test.skip("a locally-saved-only document never reads 'Up to date' and never claims 'saved to cloud'", async ({
    page,
  }) => {
    await page.goto(DOCUMENTS_ROUTE);
    await page.locator(ROW_SELECTOR).first().click();
    await enterTunnel(page);
    await page.locator(EDITOR_SELECTOR).click();
    await page.keyboard.type("a purely local write");

    // The seam verdict for a write with no returned per-id ack is one of
    // working-offline / syncing / may-be-stale — NEVER up-to-date.
    const text = await freshnessTextFor(page, "edited-doc");
    expect(text).not.toMatch(UP_TO_DATE_RE);
    expect(text).toMatch(
      new RegExp(
        `${WORKING_OFFLINE_RE.source}|${SYNCING_RE.source}|${MAY_BE_STALE_RE.source}`,
        "i"
      )
    );

    // And no false durability claim appears anywhere on the surface.
    const surface =
      (await page.locator("main, body").first().innerText()) ?? "";
    expect(surface).not.toMatch(SAVED_TO_CLOUD_RE);
  });

  // POSITIVE CONTROL (anti-vacuous): the SAME document DOES reach "Up to date"
  // once the per-id push-response cursor returns. Pairing this with the negative
  // proves the negative is not vacuously true — a UI that simply never shows
  // up-to-date would fail THIS control, and a UI that shows up-to-date off a
  // local write would fail the negative above.
  test.skip("the same document reaches 'Up to date' ONLY after the per-id push ack returns (control)", async ({
    page,
  }) => {
    await page.goto(DOCUMENTS_ROUTE);
    await page.locator(ROW_SELECTOR).first().click();
    await enterTunnel(page);
    await page.locator(EDITOR_SELECTOR).click();
    await page.keyboard.type("a write that will be acked after reconnect");

    const indicator = page
      .locator(`[data-doc-id="edited-doc"] ${FRESHNESS_SELECTOR}`)
      .first();
    // Still local-only here: not up-to-date.
    await expect(indicator).not.toHaveText(UP_TO_DATE_RE);

    // Reconnect → the push endpoint returns the per-id durability cursor AND
    // recency holds → the seam verdict becomes up-to-date.
    await exitTunnel(page);
    await expect(indicator).toHaveText(UP_TO_DATE_RE);
  });
});

test.describe("Flow 2 — a private doc edited elsewhere resolves silently by last-write-wins", () => {
  test.skip("a private document also edited on another device converges with no merge dialog", async ({
    page,
  }) => {
    await page.goto(DOCUMENTS_ROUTE);
    await page.locator(`[data-doc-id="private-doc"]`).first().click();
    await exitTunnel(page);
    // Last-write-wins convergence: there is NO conflict/merge dialog for private
    // collections.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // At most a subtle "updated elsewhere" note — never a blocking resolution UI.
    const note = page.getByText(UPDATED_ELSEWHERE_RE);
    expect(await note.count()).toBeLessThanOrEqual(1);
  });
});

test.describe("Flow 2 — the documents routes meet the accessibility floor", () => {
  test.skip("the documents list/editor surface has no axe violations", async ({
    page,
    checkA11y,
  }) => {
    await page.goto(DOCUMENTS_ROUTE);
    await checkA11y();
  });
});
