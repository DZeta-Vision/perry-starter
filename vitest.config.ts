import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Vitest 4 multi-project config. `test.projects` is the v4 replacement for the
// removed `workspace` option / `vitest.workspace.ts` (which THROW in v4).
// `coverage` and `reporters` are ROOT-ONLY — they aggregate across projects.
// See skills/vitest-playwright/SKILL.md (pinned to vitest 4.1.8).
export default defineConfig({
  plugins: [react()],
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Thresholds intentionally unset until real tests land (TD → ATDD);
      // the CI step (bmad-testarch-ci) wires them as a blocking gate.
    },
    reporters: ["default"],
    projects: [
      {
        // apps/web — React components under jsdom + @testing-library.
        test: {
          name: "web",
          environment: "jsdom",
          setupFiles: ["./apps/web/vitest.setup.ts"],
          include: ["apps/web/**/*.test.{ts,tsx}"],
        },
      },
      {
        // packages/* — pure node-env logic; the AD-17 conformance gates
        // (delta-envelope/shape/ownership, RBAC parity, AG-UI subset) live here.
        test: {
          name: "node",
          environment: "node",
          include: ["packages/**/*.test.ts"],
        },
      },
    ],
  },
});
