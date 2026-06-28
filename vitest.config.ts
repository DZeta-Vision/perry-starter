import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Vitest 4 multi-project config. `test.projects` is the v4 replacement for the
// removed `workspace` option / `vitest.workspace.ts` (which THROW in v4).
// `coverage` and `reporters` are ROOT-ONLY — they aggregate across projects.
// Pinned to vitest 4.1.8.
export default defineConfig({
  plugins: [react()],
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Thresholds intentionally unset until real tests land;
      // the CI step wires them as a blocking gate.
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
        // packages/* — pure node-env logic; the conformance gates
        // (delta-envelope/shape/ownership, RBAC parity, AG-UI subset) live here.
        test: {
          name: "node",
          environment: "node",
          include: ["packages/**/*.test.ts"],
          // Deterministic, in-repo defaults so the server env singleton (which
          // validates process.env eagerly at import) loads cleanly in tests and
          // CI without a local .env. Tests that exercise validation pass their
          // own explicit payloads, so these defaults never mask a failure.
          env: {
            PERRY_TARGET: "local-sidecar",
            SURREAL_URL: "http://127.0.0.1:8000",
            SURREAL_NS: "perry",
            SURREAL_DB: "perry",
            SURREAL_USER: "root",
            SURREAL_PASS: "root",
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
            BETTER_AUTH_URL: "http://127.0.0.1:3000",
            CORS_ORIGIN: "http://127.0.0.1:3000",
          },
        },
      },
    ],
  },
});
