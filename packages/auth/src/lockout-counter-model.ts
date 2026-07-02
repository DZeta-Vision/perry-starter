// A PURE, in-memory, single-instance counter that DEMONSTRATES the design principle
// behind the shipped Durable-Object lockout counter — it does NOT reproduce the DO's
// runtime guarantee.
//
// WHY THIS IS A DESIGN-PRINCIPLE DEMONSTRATION, NOT A RUNTIME PROOF:
// The shipped counter is a Cloudflare Durable Object whose `recordFailure` is an
// ASYNC read-modify-write over `ctx.storage`. That async RMW is safe ONLY because the
// Durable Object PLATFORM input-gates concurrent RPCs to a single instance — it
// SERIALIZES them so no two overlap mid-operation. That platform serialization is
// RELIED UPON and type-checked; it is a property of Cloudflare's runtime that CANNOT
// be reproduced in-process (there is no isolate to gate against in a unit test).
// This model is exact for a DIFFERENT reason: `recordFailure` is a SYNCHRONOUS
// read-modify-write, so single-threaded JS simply cannot interleave two increments.
// It therefore illustrates the DESIGN PRINCIPLE — a serialized read-modify-write
// yields exact counts — and its mutation twin shows the contrapositive: a NAIVE
// non-serialized async RMW (the shipped DO's RMW WITHOUT the platform's gating) loses
// updates. Read together they say: the shipped DO's async RMW is correct only under
// the platform's serialization. They do NOT exercise a live DO's concurrency; that
// gap is deferred to the worker/e2e harness.
//
// Counters are keyed by the shared `lockoutCounterKey({ kind, subject })`, so the
// per-account (`account:<subject>`) and per-IP (`ip:<subject>`) perimeters are
// DISTINCT keys and can never share a counter.

export interface LockoutCounterModel {
  // Read the current count WITHOUT incrementing (the pre-attempt check).
  peek(key: string): number;
  // Increment the key's counter and return the EXACT post-increment value. The
  // synchronous read-modify-write DEMONSTRATES the design principle — a serialized
  // RMW yields exact counts — that the runtime DO obtains from platform gating.
  recordFailure(key: string): number;
  // Clear a key's counter (a successful auth resets that subject's ladder).
  reset(key: string): void;
}

export const createLockoutCounterModel = (): LockoutCounterModel => {
  const counts = new Map<string, number>();
  return {
    peek: (key) => counts.get(key) ?? 0,
    recordFailure: (key) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    reset: (key) => {
      counts.delete(key);
    },
  };
};
