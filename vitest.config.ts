import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Vitest 4 multi-project config. `test.projects` is the v4 replacement for the
// removed `workspace` option / `vitest.workspace.ts` (which THROW in v4).
// `coverage` and `reporters` are ROOT-ONLY — they aggregate across projects.
// Pinned to vitest 4.1.8.

// Deterministic, in-repo defaults so the server env singleton (which validates
// process.env eagerly at import) loads cleanly in tests and CI without a local
// .env. Tests that exercise validation pass their own explicit payloads, so
// these defaults never mask a failure. Shared by the node + daemon projects.
const inRepoEnv = {
  PERRY_TARGET: "local-sidecar",
  SURREAL_URL: "http://127.0.0.1:8000",
  SURREAL_NS: "perry",
  SURREAL_DB: "perry",
  SURREAL_USER: "root",
  SURREAL_PASS: "root",
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
  BETTER_AUTH_URL: "http://127.0.0.1:3000",
  CORS_ORIGIN: "http://127.0.0.1:3000",
};

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
          // The shell-render integration tests legitimately take ~2s (jsdom
          // mount of the full header graph); under multi-project CI contention
          // that can approach the 5s default and spuriously time out. Headroom
          // costs nothing for passing tests and still fails a real hang.
          testTimeout: 15_000,
        },
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
          },
        },
      },
      {
        // packages/* — pure node-env logic; the conformance gates
        // (delta-envelope/shape/ownership, RBAC parity, AG-UI subset) live here.
        test: {
          name: "node",
          environment: "node",
          // packages/* conformance gates + the repo-root scripts/* gates
          // (rename/remove-reference/thin-scope) which also run as node:fs gates.
          include: ["packages/**/*.test.ts", "scripts/**/*.test.ts"],
          env: inRepoEnv,
          // The auth acceptance/gate suites drive the REAL better-auth handler over
          // an in-memory adapter — each sign-up/verify round-trips through scrypt
          // password hashing, which is deliberately slow and, under multi-file CI
          // contention, can exceed the 5s default. Headroom costs nothing for the
          // (majority) pure-logic tests and still fails a real hang.
          testTimeout: 30_000,
        },
        resolve: {
          alias: {
            // TEST-ONLY shim: the DB-layer ES256 fail-closed test in packages/data
            // mints tokens with the non-prod fixture that pairs with the schema's
            // JWT public key. The fixture lives in packages/auth, but packages/data
            // must NOT declare a build-graph dependency on the auth tier (the seam
            // tier sits below auth). This alias resolves the fixture for the test
            // runner only; it adds no runtime/package.json edge.
            "@perry-starter/auth/test-jwt": fileURLToPath(
              new URL("./packages/auth/src/test-jwt.ts", import.meta.url)
            ),
            // TEST-ONLY shim (same rationale as above): the anti-enumeration
            // matrix test lives in packages/db (the canonical neutral envelope's
            // home) and drives the pre-auth registration surfaces, which live in
            // the higher auth tier's acceptance harness. packages/db must NOT
            // declare a build-graph dependency on auth (db sits below auth), so the
            // test runner resolves this specifier here. No runtime/package.json edge.
            "@perry-starter/auth/test-harness": fileURLToPath(
              new URL("./packages/auth/src/test-harness.ts", import.meta.url)
            ),
          },
        },
      },
      {
        // apps/daemon — the PerryTS host logic (serve-path, reply.type,
        // supervisor, bind-check, documents-read) under node, driven via fastify
        // `inject()` + a real in-memory `surreal` sidecar.
        test: {
          name: "daemon",
          environment: "node",
          include: ["apps/daemon/**/*.test.ts"],
          env: inRepoEnv,
          // Run the daemon files serially in a single fork: several spawn a real
          // in-memory `surreal` sidecar, and running them concurrently races on
          // sidecar spawn/health-poll/ports. Single-fork isolation removes that
          // flake without weakening any control. (Egress gates now inject `fetch`
          // rather than stubbing the global, so the other race source is gone.)
          poolOptions: { forks: { singleFork: true } },
          // Sidecar spawn + /health poll can be slow under CI contention; give
          // the same headroom as the web project.
          testTimeout: 15_000,
        },
      },
    ],
  },
});
