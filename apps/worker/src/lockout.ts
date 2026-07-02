import { DurableObject } from "cloudflare:workers";
import { buildLockoutResponse } from "@perry-starter/api/lockout-envelope";
import {
  DEFAULT_LOCKOUT_THRESHOLDS,
  describeLockoutTunables,
  type LockoutCounterState,
  type LockoutThresholds,
  nextLockedUntilMs,
  type ResolvedLockoutState,
  resolveLockoutState,
  strongerLockoutState,
} from "@perry-starter/auth/lockout-policy";
import {
  configureLockoutRecorder,
  lockoutCounterKey,
  recordLoginFailure,
} from "@perry-starter/auth/lockout-seam";
import {
  isCredentialFailure,
  normalizeAccountSubject,
} from "@perry-starter/auth/login-outcome";
import { verifyTurnstileToken } from "@perry-starter/auth/turnstile";

// The strongly-consistent Durable-Object lockout counter (SQLite-backed). Cloudflare
// routes every RPC for a given key-name to ONE instance and SERIALIZES them, so the
// read-modify-write here can never lose an update — this is the authoritative
// throttle. One instance per counter key (`account:<subject>` / `ip:<subject>`), so
// the per-account and per-IP perimeters are physically distinct. NEVER a Cloudflare
// KV namespace (eventually consistent). Re-exported from the worker entrypoint so
// Cloudflare can locate the class; its name MUST equal the alchemy `className`.
//
// The instance persists `{ count, lockedUntilMs }` — the running count AND the
// wall-clock instant a timed lock LIFTS. The timed-lift + reset DECISION is the pure
// `resolveLockoutState` / `nextLockedUntilMs` (tested in @perry-starter/auth); this
// class is only the clock (`Date.now()`) + storage glue around them, so a timed lock
// genuinely expires and can never become a permanent one.
const COUNTER_STORAGE_KEY = "state";

const EMPTY_STATE: LockoutCounterState = { count: 0, lockedUntilMs: 0 };

export class LockoutCounter extends DurableObject {
  private async load(): Promise<LockoutCounterState> {
    return (
      (await this.ctx.storage.get<LockoutCounterState>(COUNTER_STORAGE_KEY)) ??
      EMPTY_STATE
    );
  }

  // Increment this instance's counter and return the EXACT post-increment count.
  // When the count FIRST reaches `lockAt`, stamp the timed-lock window so a later
  // read can lift it once the window passes (the stamp instant is decided by the
  // pure `nextLockedUntilMs`; `Date.now()` is the only clock read here).
  async recordFailure(
    thresholds: LockoutThresholds = DEFAULT_LOCKOUT_THRESHOLDS
  ): Promise<number> {
    const current = await this.load();
    const count = current.count + 1;
    const lockedUntilMs = nextLockedUntilMs(
      count,
      current.lockedUntilMs,
      Date.now(),
      thresholds
    );
    await this.ctx.storage.put<LockoutCounterState>(COUNTER_STORAGE_KEY, {
      count,
      lockedUntilMs,
    });
    return count;
  }

  // Read + RESOLVE this instant's effective tier (the pre-attempt gate check). If a
  // timed lock's window has fully elapsed the pure resolver reports `reset`, and this
  // glue PERSISTS the clear so the subject genuinely starts fresh — the fix that
  // stops a timed lock from being permanent.
  async assess(
    thresholds: LockoutThresholds = DEFAULT_LOCKOUT_THRESHOLDS
  ): Promise<ResolvedLockoutState> {
    const current = await this.load();
    const resolved = resolveLockoutState(current, Date.now(), thresholds);
    if (resolved.reset) {
      await this.ctx.storage.delete(COUNTER_STORAGE_KEY);
    }
    return resolved;
  }

  // Clear the counter — a successful auth resets that subject's ladder.
  async reset(): Promise<void> {
    await this.ctx.storage.delete(COUNTER_STORAGE_KEY);
  }
}

export interface LockoutEnv {
  readonly LOCKOUT: DurableObjectNamespace<LockoutCounter>;
  readonly TURNSTILE_SECRET: string;
}

// Idempotent boot binding: wire the shared per-subject lockout-recording seam to
// the real DO counter (so a failed login / failed step-up increments the strongly-
// consistent counter through the SAME reason-independent key), and LOG the chosen
// (defaulted, operator-owned) tunables so they are observable in the deploy logs.
let recorderBound = false;
export const bindWorkerLockoutRecorder = (
  env: LockoutEnv,
  thresholds: LockoutThresholds = DEFAULT_LOCKOUT_THRESHOLDS
): void => {
  if (recorderBound) {
    return;
  }
  recorderBound = true;
  // The chosen defaults are a DEFAULTED TUNABLE — logged, not silent, so a later
  // hardening artifact can pin them from observed deploy logs.
  console.info(
    JSON.stringify({
      event: "lockout.tunables",
      thresholds: describeLockoutTunables(thresholds),
    })
  );
  configureLockoutRecorder((failure) => {
    // Fire-and-forget increment of the authoritative DO counter (the recorder seam
    // is void; the escalation DECISION happens in the login gate below). A transient
    // DO error must never break the request path, so swallow it. The chosen
    // thresholds ride through so the DO stamps the lock window at the SAME `lockAt`.
    env.LOCKOUT.getByName(lockoutCounterKey(failure))
      .recordFailure(thresholds)
      .catch(() => undefined);
  });
};

export interface LoginLockoutAttempt {
  readonly email: string;
  // Absent (`undefined`) when the platform gives no client IP — the per-IP perimeter
  // is then SKIPPED rather than collapsing every anonymous attempt onto one shared
  // `ip:` counter (which would let one attacker lock out unrelated users).
  readonly remoteip?: string;
  readonly turnstileToken?: string;
}

// Resolve the effective (strongest) tier across BOTH perimeters. Each counter is a
// DISTINCT DO instance that lifts its own timed lock independently; the gate takes
// the STRONGER of the two resolved states via the pure `strongerLockoutState`.
const resolveAttemptState = async (
  env: LockoutEnv,
  attempt: LoginLockoutAttempt,
  thresholds: LockoutThresholds
): Promise<ResolvedLockoutState> => {
  const account = normalizeAccountSubject(attempt.email);
  const accountState = await env.LOCKOUT.getByName(
    lockoutCounterKey({ kind: "account", subject: account })
  ).assess(thresholds);
  if (attempt.remoteip === undefined || attempt.remoteip === "") {
    return accountState;
  }
  const ipState = await env.LOCKOUT.getByName(
    lockoutCounterKey({ kind: "ip", subject: attempt.remoteip })
  ).assess(thresholds);
  return strongerLockoutState(accountState, ipState);
};

// The pre-attempt lockout GATE, run INSIDE the login handler BEFORE delegating to
// better-auth. It resolves BOTH the per-account AND per-IP counters (two DISTINCT
// counters, each lifting its own timed lock), takes the STRONGEST tier, and:
//   - locked  -> returns a 429 + Retry-After lockout Response (deny now). The
//     Retry-After is the REMAINING window from the resolver, so once it elapses the
//     next read lifts the lock and the subject proceeds — never a permanent lock;
//   - captcha -> siteverifies the Turnstile token SERVER-SIDE; a missing/failed
//     token is denied with the SAME generic lockout Response (the DO count, not the
//     CAPTCHA, is the authoritative throttle);
//   - friction -> the PRE-CAPTCHA grace tier: the attempt is allowed to proceed
//     while the counter keeps climbing toward the CAPTCHA/lock tiers. No extra
//     server-side friction is enforced today (documented as a deferral); it exists
//     as a distinct, monotonic rung so a later hardening artifact can attach a delay
//     or a soft challenge without reshaping the ladder;
//   - none -> returns null (proceed to better-auth).
export const assessLoginLockout = async (
  env: LockoutEnv,
  attempt: LoginLockoutAttempt,
  thresholds: LockoutThresholds = DEFAULT_LOCKOUT_THRESHOLDS
): Promise<Response | null> => {
  const decision = await resolveAttemptState(env, attempt, thresholds);

  if (decision.tier === "locked") {
    return buildLockoutResponse(decision.retryAfterSeconds);
  }
  if (decision.tier === "captcha") {
    const verdict = await verifyTurnstileToken(
      {
        remoteip: attempt.remoteip ?? "",
        secret: env.TURNSTILE_SECRET,
        token: attempt.turnstileToken ?? "",
      },
      { fetch }
    );
    if (!verdict.success) {
      // The generic locked surface, identical for locked and rate-limited — the
      // CAPTCHA gate did not clear, so treat it as the timed-lock window.
      return buildLockoutResponse(thresholds.lockDurationSeconds);
    }
  }
  return null;
};

// Record a failed login against BOTH perimeters (per-account normalized + per-IP)
// through the shared seam -> the DO counters. Called ONLY after better-auth reports a
// genuine CREDENTIAL failure (see `isCredentialFailure`) — never a verification-wall
// 403, so a correct-password-but-unverified owner never accrues a strike. Skips the
// IP perimeter when the platform gave no client IP (no shared `ip:` counter).
export const recordFailedLogin = (
  attempt: Pick<LoginLockoutAttempt, "email" | "remoteip">
): void => {
  recordLoginFailure(normalizeAccountSubject(attempt.email), "account");
  if (attempt.remoteip !== undefined && attempt.remoteip !== "") {
    recordLoginFailure(attempt.remoteip, "ip");
  }
};

// Reset BOTH perimeters on a SUCCESSFUL sign-in — a real owner proving the
// credential clears their ladder so a prior partial climb never carries over. Skips
// the IP perimeter when no client IP was presented.
export const resetSubjectLockout = (
  env: LockoutEnv,
  attempt: Pick<LoginLockoutAttempt, "email" | "remoteip">
): void => {
  const account = normalizeAccountSubject(attempt.email);
  env.LOCKOUT.getByName(
    lockoutCounterKey({ kind: "account", subject: account })
  )
    .reset()
    .catch(() => undefined);
  if (attempt.remoteip !== undefined && attempt.remoteip !== "") {
    env.LOCKOUT.getByName(
      lockoutCounterKey({ kind: "ip", subject: attempt.remoteip })
    )
      .reset()
      .catch(() => undefined);
  }
};

// Whether a completed sign-in delegation should record a lockout strike: ONLY a
// genuine credential miss (HTTP 401), never a downstream block such as an unverified
// email (403). Re-exported thin wrapper so the entrypoint reads one named predicate.
export const shouldRecordLoginFailure = (status: number): boolean =>
  isCredentialFailure(status);
