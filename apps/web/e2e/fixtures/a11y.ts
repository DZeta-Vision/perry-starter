import AxeBuilder from "@axe-core/playwright";
import { test as base, expect } from "@playwright/test";

// Reusable accessibility fixture backing the AD-33 floor + the AD-17 full-route
// accessibility-behavior gate (bmad-testarch-ci wires it to run over the whole
// apps/web route inventory). Scans the current page against WCAG 2.0/2.1/2.2 A+AA
// and asserts zero violations.
// Consumers import the extended `test` from here and `expect` from
// "@playwright/test" directly (no barrel re-export, per Ultracite).
export const test = base.extend<{ checkA11y: () => Promise<void> }>({
  checkA11y: async ({ page }, use) => {
    await use(async () => {
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(
        results.violations,
        `a11y violations: ${results.violations.map((v) => v.id).join(", ")}`
      ).toEqual([]);
    });
  },
});
