import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// The server env contract. PERRY_TARGET selects the runtime target at build
// time; the SURREAL_* contract configures the data engine. BETTER_AUTH_* and
// CORS_ORIGIN remain validated. The legacy DATABASE_URL is intentionally absent.
const serverEnvShape = {
  PERRY_TARGET: z.enum(["local-sidecar", "cloud-relay"]),
  SURREAL_URL: z.url(),
  SURREAL_NS: z.string().min(1),
  SURREAL_DB: z.string().min(1),
  SURREAL_USER: z.string().min(1),
  SURREAL_PASS: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  CORS_ORIGIN: z.url(),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
};

// Pure, side-effect-free parse seam for deterministic validation (tests and
// callers validating an explicit payload, decoupled from process.env). `.strict()`
// rejects unknown keys, so a re-added legacy DATABASE_URL fails validation.
export const serverEnvSchema = z.object(serverEnvShape).strict();

export const parseServerEnv = (input: Record<string, unknown>) =>
  serverEnvSchema.parse(input);

// App singleton: validated once from process.env at load for app consumers.
export const env = createEnv({
  server: serverEnvShape,
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
