import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// The server env contract. PERRY_TARGET selects the runtime target; the
// SURREAL_* contract configures the data engine. BETTER_AUTH_* and CORS_ORIGIN
// remain validated. The legacy DATABASE_URL is intentionally absent.
//
// SURREAL_* is REQUIRED only for the data-owner context and is NOT required for
// the relay tier. The discriminator is PERRY_TARGET:
//   - `local-sidecar` — the local daemon owns the SurrealDB binding directly, so
//     the full SURREAL_* contract is required.
//   - `cloud-relay` — the apps/web relay reaches data THROUGH the apps/worker
//     gatekeeper and holds NO SURREAL_* binding, so SURREAL_* is optional; the
//     gatekeeper's binding is supplied by the Alchemy program. Eagerly requiring
//     SURREAL_* here would make the relay throw "Invalid environment variables"
//     at boot.
const SURREAL_KEYS = [
  "SURREAL_URL",
  "SURREAL_NS",
  "SURREAL_DB",
  "SURREAL_USER",
  "SURREAL_PASS",
] as const;

// SURREAL_* fields are individually optional in the base shape; the conditional
// refinement below promotes them to required for the data-owner target. Keeping
// them in the shape means `serverEnvSchema.shape` still owns every SURREAL_* key.
const serverEnvShape = {
  PERRY_TARGET: z.enum(["local-sidecar", "cloud-relay"]),
  SURREAL_URL: z.url().optional(),
  SURREAL_NS: z.string().min(1).optional(),
  SURREAL_DB: z.string().min(1).optional(),
  SURREAL_USER: z.string().min(1).optional(),
  SURREAL_PASS: z.string().min(1).optional(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  CORS_ORIGIN: z.url(),
  // Server-side OAuth provider credentials, consumed by the cloud better-auth
  // authority. Optional on the contract: only the cloud-authority host carries
  // them, so the relay tier (which holds none) still validates at boot.
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
};

const SURREAL_REQUIRED_MESSAGE =
  "SURREAL_* is required when PERRY_TARGET is local-sidecar (the data-owner context)";

// The conditional requiredness rule: the data-owner target (local-sidecar) MUST
// carry the full SURREAL_* contract; any other target may omit it.
const surrealContractSatisfied = (value: Record<string, unknown>): boolean =>
  value.PERRY_TARGET !== "local-sidecar" ||
  SURREAL_KEYS.every((key) => value[key] !== undefined);

// Pure, side-effect-free parse seam for deterministic validation (tests and
// callers validating an explicit payload, decoupled from process.env). `.strict()`
// rejects unknown keys, so a re-added legacy DATABASE_URL fails validation; the
// schema itself stays a ZodObject so `serverEnvSchema.shape` exposes the keys.
export const serverEnvSchema = z.object(serverEnvShape).strict();

const serverEnvContract = serverEnvSchema.refine(surrealContractSatisfied, {
  message: SURREAL_REQUIRED_MESSAGE,
});

export const parseServerEnv = (input: Record<string, unknown>) =>
  serverEnvContract.parse(input);

// SURREAL_* is optional on the validator (the relay tier carries none), so the
// raw inferred type would be `string | undefined`. But every reader of
// `env.SURREAL_*` runs in a data-owner context (the local-sidecar daemon or the
// gatekeeper worker) that DOES hold the binding — and a misconfigured data owner
// is already caught at boot by the conditional refine below. Narrow the
// singleton's type so those consumers keep plain `string`s.
type ServerEnv = Omit<
  z.output<typeof serverEnvSchema>,
  "SURREAL_DB" | "SURREAL_NS" | "SURREAL_PASS" | "SURREAL_URL" | "SURREAL_USER"
> & {
  SURREAL_DB: string;
  SURREAL_NS: string;
  SURREAL_PASS: string;
  SURREAL_URL: string;
  SURREAL_USER: string;
};

// App singleton: validated once from process.env at load for app consumers. The
// conditional SURREAL_* requiredness rides `createFinalSchema` so the same rule
// gates boot. Not `.strict()` here — process.env legitimately carries unrelated
// keys the dictionary validator must ignore. The runtime schema is the genuine
// refined validator; the cast only narrows the inferred type for consumers.
export const env = createEnv({
  server: serverEnvShape,
  createFinalSchema: (shape) =>
    z.object(shape).refine(surrealContractSatisfied, {
      message: SURREAL_REQUIRED_MESSAGE,
    }) as unknown as z.ZodType<ServerEnv, ServerEnv>,
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
