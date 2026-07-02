import { scrubSecrets } from "@perry-starter/env/scrub";
import { env } from "@perry-starter/env/server";
import {
  type Breadcrumb,
  close,
  type ErrorEvent,
  init,
  type Log,
  pinoIntegration,
  type SeverityLevel,
  addBreadcrumb as sentryAddBreadcrumb,
  captureException as sentryCaptureException,
  captureMessage as sentryCaptureMessage,
  setUser as sentrySetUser,
  startSpan,
  type User,
} from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

// Sentry configuration from the VALIDATED env contract (never raw process.env):
// SENTRY_* live in @perry-starter/env, coerced + bounded, per-environment tagged.
const dsn = env.SENTRY_DSN;
const environment = env.SENTRY_ENVIRONMENT;
const tracesSampleRate = env.SENTRY_TRACES_SAMPLE_RATE;
const profilesSampleRate = env.SENTRY_PROFILES_SAMPLE_RATE;

// The NFR redaction hooks. `scrubSecrets` is the ONE shared deny-list scrubber
// (also used by the daemon reporter): a secret-bearing attribute is stripped
// before the log/event leaves this process — a token/password/cookie never
// reaches Sentry. Logs keep their event type + actor; secrets are redacted.
const redactLog = (log: Log): Log => {
  if (log.attributes) {
    log.attributes = scrubSecrets(log.attributes);
  }
  return log;
};

const redactEvent = (event: ErrorEvent): ErrorEvent => {
  if (event.extra) {
    event.extra = scrubSecrets(event.extra);
  }
  if (event.contexts) {
    event.contexts = scrubSecrets(event.contexts);
  }
  if (event.request) {
    event.request = scrubSecrets(event.request);
  }
  return event;
};

/**
 * Initialize Sentry for error tracking and performance monitoring
 * Call this at the very beginning of your application, before any other imports
 *
 * @example
 * // At the top of your main entry file (e.g., index.ts)
 * import { initSentry } from './lib/sentry';
 * initSentry();
 *
 * // Then import and start your application
 * import { app } from './app';
 */
export function initSentry(): void {
  if (!dsn) {
    console.warn("[Sentry] DSN not configured, skipping initialization");
    return;
  }

  init({
    dsn,
    environment,
    // `enableLogs` is a TOP-LEVEL option (not `_experiments`); pino → Sentry log
    // forwarding only flows when it is on.
    enableLogs: true,
    integrations: [
      // Add profiling integration for performance insights
      nodeProfilingIntegration(),
      // Bridge pino → Sentry. `error.levels` defaults to [] — without it, pino
      // errors forward as logs but never as Sentry exception events.
      pinoIntegration({ error: { levels: ["error", "fatal"] } }),
    ],
    // NFR redaction: strip secret-bearing attributes from every log and event
    // before send (the load-bearing "never payload/secrets" control).
    beforeSendLog: redactLog,
    beforeSend: redactEvent,
    // Performance Monitoring
    tracesSampleRate,
    // Set sampling rate for profiling - this is relative to tracesSampleRate
    profilesSampleRate,
  });

  console.log(`[Sentry] Initialized for ${environment}`);
}

/**
 * Gracefully close Sentry
 * Call this before your application exits to ensure all events are flushed
 *
 * @example
 * process.on('SIGTERM', async () => {
 *   await closeSentry();
 *   process.exit(0);
 * });
 */
export async function closeSentry(): Promise<void> {
  try {
    await close(2000);
    console.log("[Sentry] Closed successfully");
  } catch (error) {
    console.error("[Sentry] Error closing:", error);
  }
}

/**
 * Capture an exception with Sentry
 *
 * @example
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   captureException(error);
 * }
 */
export function captureException(error: Error | unknown): string {
  return sentryCaptureException(error);
}

/**
 * Capture a message with Sentry
 *
 * @example
 * captureMessage("User completed checkout", "info");
 */
export function captureMessage(
  message: string,
  level: SeverityLevel = "info"
): string {
  return sentryCaptureMessage(message, level);
}

/**
 * Set user context for Sentry
 *
 * @example
 * setUser({ id: "123", email: "user@example.com" });
 */
export function setUser(user: User | null): void {
  sentrySetUser(user);
}

/**
 * Add a breadcrumb for debugging context
 *
 * @example
 * addBreadcrumb({
 *   category: "auth",
 *   message: "User logged in",
 *   level: "info",
 * });
 */
export function addBreadcrumb(breadcrumb: Breadcrumb): void {
  sentryAddBreadcrumb(breadcrumb);
}

/**
 * Create a span for performance monitoring
 *
 * @example
 * const result = await withSpan(
 *   { name: "database-query", op: "db.query" },
 *   async () => {
 *     return await db.query("SELECT * FROM users");
 *   }
 * );
 */
export function withSpan<T>(
  context: Parameters<typeof startSpan>[0],
  callback: () => Promise<T>
): Promise<T> {
  return startSpan(context, callback);
}

/**
 * Environment Variables:
 *
 * SENTRY_DSN - Your Sentry DSN from the project settings (required)
 * SENTRY_ENVIRONMENT - Environment name (default: development)
 * SENTRY_TRACES_SAMPLE_RATE - Sample rate for performance monitoring 0.0-1.0 (default: 1.0)
 * SENTRY_PROFILES_SAMPLE_RATE - Sample rate for profiling 0.0-1.0 (default: 0.1)
 *
 * Getting started:
 * 1. Create a project at https://sentry.io
 * 2. Copy your DSN from Project Settings > Client Keys
 * 3. Set SENTRY_DSN in your .env file
 *
 * Production recommendations:
 * - Set SENTRY_TRACES_SAMPLE_RATE to 0.1-0.2 to reduce costs
 * - Set SENTRY_PROFILES_SAMPLE_RATE to 0.1 or lower
 * - Configure release tracking with SENTRY_RELEASE env var
 */
