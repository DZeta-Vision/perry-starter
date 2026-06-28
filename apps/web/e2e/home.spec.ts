import { expect, test } from "@playwright/test";

// Harness smoke — proves the Playwright config + `bun dev` webServer wiring
// (testDir apps/web/e2e, baseURL :3001). Requires the dev stack up; real
// flow coverage arrives via TD → ATDD against the EXPERIENCE.md key flows.
test("home page loads", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.ok()).toBeTruthy();
  await expect(page.locator("body")).toBeVisible();
});
