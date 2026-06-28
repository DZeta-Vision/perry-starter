import { expect, test } from "vitest";

// The server env contract gains a required, value-constrained PERRY_TARGET enum
// ('local-sidecar' | 'cloud-relay') alongside the SURREAL_* contract;
// BETTER_AUTH_*/CORS_ORIGIN stay validated; and the legacy DATABASE_URL is not
// reintroduced.
//
// The pure parse seam (parseServerEnv / serverEnvSchema) is imported dynamically
// inside each test body so the env module's validation runs only when the test
// runs, never at file collection.

const SECRET_MIN_LENGTH = 32;
const SERVER_ENV_MODULE = "@perry-starter/env/server";

interface ServerEnvModule {
  parseServerEnv: (input: Record<string, unknown>) => unknown;
  serverEnvSchema: { shape: Record<string, unknown> };
}

const validServerEnv = (): Record<string, unknown> => ({
  PERRY_TARGET: "local-sidecar",
  SURREAL_URL: "http://127.0.0.1:8000",
  SURREAL_NS: "perry",
  SURREAL_DB: "perry",
  SURREAL_USER: "root",
  SURREAL_PASS: "root",
  BETTER_AUTH_SECRET: "x".repeat(SECRET_MIN_LENGTH),
  BETTER_AUTH_URL: "http://127.0.0.1:3000",
  CORS_ORIGIN: "http://127.0.0.1:3000",
  NODE_ENV: "test",
});

const withoutKey = (input: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(input).filter(([k]) => k !== key));

test("a valid PERRY_TARGET + SURREAL env parses for both target values and the schema carries no DATABASE_URL key", async () => {
  const mod: ServerEnvModule = await import(SERVER_ENV_MODULE);

  // A fully valid env parses for BOTH legal PERRY_TARGET values — proving the
  // enum membership includes exactly {local-sidecar, cloud-relay}.
  expect(() => mod.parseServerEnv(validServerEnv())).not.toThrow();
  expect(() =>
    mod.parseServerEnv({ ...validServerEnv(), PERRY_TARGET: "cloud-relay" })
  ).not.toThrow();

  const shapeKeys = Object.keys(mod.serverEnvSchema.shape);
  // The contract owns PERRY_TARGET + the SURREAL_* keys...
  expect(shapeKeys).toContain("PERRY_TARGET");
  expect(shapeKeys).toContain("SURREAL_URL");
  // ...and BETTER_AUTH_*/CORS_ORIGIN remain validated...
  expect(shapeKeys).toContain("BETTER_AUTH_SECRET");
  expect(shapeKeys).toContain("CORS_ORIGIN");
  // ...while the legacy DATABASE_URL is provably absent (this fails the moment
  // a dangling DATABASE_URL is reintroduced).
  expect(shapeKeys).not.toContain("DATABASE_URL");
});

test("invalid PERRY_TARGET, missing PERRY_TARGET, missing SURREAL_URL, and a reintroduced DATABASE_URL each fail validation", async () => {
  const mod: ServerEnvModule = await import(SERVER_ENV_MODULE);

  // An out-of-enum PERRY_TARGET is rejected (fail-closed at startup).
  expect(() =>
    mod.parseServerEnv({ ...validServerEnv(), PERRY_TARGET: "nope" })
  ).toThrow();

  // A missing PERRY_TARGET is rejected (required, no default).
  expect(() =>
    mod.parseServerEnv(withoutKey(validServerEnv(), "PERRY_TARGET"))
  ).toThrow();

  // A missing SURREAL_URL is rejected (the SURREAL contract is required).
  expect(() =>
    mod.parseServerEnv(withoutKey(validServerEnv(), "SURREAL_URL"))
  ).toThrow();

  // Re-adding the legacy DATABASE_URL is rejected by the strict contract —
  // DATABASE_URL is not part of the PERRY_TARGET/SURREAL seam.
  expect(() =>
    mod.parseServerEnv({
      ...validServerEnv(),
      DATABASE_URL: "postgres://localhost:5432/legacy",
    })
  ).toThrow();
});
