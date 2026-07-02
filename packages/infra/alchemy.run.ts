import alchemy from "alchemy";
import {
  DurableObjectNamespace,
  TanStackStart,
  Worker,
} from "alchemy/cloudflare";
import { config } from "dotenv";

config({ path: "./.env" });
config({ path: "../../apps/web/.env" });

const app = await alchemy("perry-starter");

// The strongly-consistent progressive-lockout counter namespace. A Durable Object
// (SQLite-backed) — NEVER Cloudflare KV (eventually consistent): every per-key RPC
// serializes on ONE instance so failed-attempt counts can't lose an update, and
// the per-account (`account:<subject>`) and per-IP (`ip:<subject>`) perimeters get
// physically distinct instances. The `id` "lockout" is the IMMUTABLE migration
// key; `className` must match the `LockoutCounter` class re-exported from the
// worker entrypoint. Synchronous factory — no await/new.
const lockout = DurableObjectNamespace("lockout", {
  className: "LockoutCounter",
  sqlite: true,
});

// The cloud gatekeeper: the auth-authority / cloud data ingress. better-auth is
// the SOLE session/token issuer, and this is the ONLY server unit that reaches
// cloud SurrealDB — it holds the single runtime (non-DDL) cloud-SurrealDB
// credential binding. Schema DDL/migration creds are a deploy-only pipeline
// concern, never a runtime binding here.
export const gatekeeper = await Worker("gatekeeper", {
  cwd: "../../apps/worker",
  entrypoint: "./src/worker.ts",
  compatibility: "node",
  // The observe-first cleanup sweep runs on THIS Worker (the sole cloud-SurrealDB
  // holder) on a daily cron. The cron only fires the scheduled() handler; the
  // observe/sweep toggle (CLEANUP_MODE, default observe) and the window
  // (CLEANUP_WINDOW_HOURS, default 48h) govern what it actually does — so a fresh
  // deployment observes before it ever removes anything.
  crons: ["0 3 * * *"],
  bindings: {
    PERRY_TARGET: alchemy.env.PERRY_TARGET,
    CORS_ORIGIN: alchemy.env.CORS_ORIGIN,
    BETTER_AUTH_SECRET: alchemy.secret.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: alchemy.env.BETTER_AUTH_URL,
    SURREAL_URL: alchemy.secret.env.SURREAL_URL,
    SURREAL_NS: alchemy.env.SURREAL_NS,
    SURREAL_DB: alchemy.env.SURREAL_DB,
    SURREAL_USER: alchemy.secret.env.SURREAL_USER,
    SURREAL_PASS: alchemy.secret.env.SURREAL_PASS,
    // The progressive-lockout DO counters + the Turnstile server-side siteverify
    // secret. The DO namespace is the authoritative throttle (strongly consistent,
    // never KV); the Turnstile secret is per-widget and reaches the handler as
    // env.TURNSTILE_SECRET (alchemy.secret -> secret_text, never wrangler secret put).
    LOCKOUT: lockout,
    TURNSTILE_SECRET: alchemy.secret.env.TURNSTILE_SECRET,
    // Observe-first cleanup config (operator-tunable per stage). Read from
    // process.env with an observe-first fallback: an unset knob deploys the
    // fail-safe dry-run posture (observe / 48h); a stage opts into destruction by
    // setting CLEANUP_MODE=sweep explicitly. (NB: the two-arg `alchemy.env(name,
    // value)` form returns `value` unconditionally without reading the env, so it
    // must NOT be used for a defaulted-but-overridable knob — read process.env
    // directly here.)
    CLEANUP_MODE: process.env.CLEANUP_MODE ?? "observe",
    CLEANUP_WINDOW_HOURS: process.env.CLEANUP_WINDOW_HOURS ?? "48",
  },
});

export const web = await TanStackStart("web", {
  cwd: "../../apps/web",
  // The web relay holds NO runtime cloud-SurrealDB credential: it reaches
  // cloud data THROUGH the gatekeeper worker above, and forwards auth ingress to
  // it. The cloud SURREAL_* credential binding lives ONLY on the gatekeeper.
  bindings: {
    PERRY_TARGET: alchemy.env.PERRY_TARGET,
    CORS_ORIGIN: alchemy.env.CORS_ORIGIN,
    BETTER_AUTH_SECRET: alchemy.secret.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: alchemy.env.BETTER_AUTH_URL,
  },
});

console.log(`Gatekeeper -> ${gatekeeper.url}`);
console.log(`Web        -> ${web.url}`);

await app.finalize();
