// Conformance gate — DEMONSTRATES THE DESIGN PRINCIPLE behind the strongly-consistent
// counter (a serialized read-modify-write yields exact counts) and proves the
// per-account vs per-IP perimeters are DISTINCT counters. It does NOT prove the
// shipped Durable Object's RUNTIME property.
//
// HONEST SCOPE: strong consistency at runtime is the Durable Object PLATFORM's
// guarantee — Cloudflare input-gates concurrent RPCs to a single instance and
// SERIALIZES them, so the shipped DO's ASYNC read-modify-write cannot lose an update.
// That platform serialization is RELIED UPON and type-checked; it CANNOT be
// reproduced in CI (there is no isolate to gate against in a unit test). This gate
// instead demonstrates the DESIGN PRINCIPLE against a deterministic in-memory model:
//   - sequential increments through the ONE instance yield an EXACT count;
//   - increments scheduled via Promise.all still land an EXACT count — but ONLY
//     because a SYNCHRONOUS read-modify-write in single-threaded JS cannot interleave
//     (a DIFFERENT mechanism than the DO's per-instance RPC gating); it illustrates
//     the principle "a serialized RMW is exact", not the DO's runtime behaviour;
//   - `lockoutCounterKey({ kind: "account" })` and `{ kind: "ip" }` for the SAME
//     subject are DISTINCT keys, so the two perimeters never share a counter.
// The mutation twin (lockout-counter.mutation.test.ts) drives a NAIVE non-serialized
// async read-modify-write (the DO's RMW WITHOUT the platform's gating) that genuinely
// LOSES updates under Promise.all — the contrapositive. Read together they say the
// shipped DO's async RMW is correct ONLY under the platform's serialization. Live-DO
// concurrency is not exercised here (deferred to the worker/e2e harness).

import { createLockoutCounterModel } from "@perry-starter/auth/lockout-counter-model";
import { lockoutCounterKey } from "@perry-starter/auth/lockout-seam";
import { describe, expect, test } from "vitest";

const ATTEMPTS = 25;

describe("the counter is exact — the serialized-RMW design principle (not the DO runtime)", () => {
  test("sequential increments through one instance yield an exact count", () => {
    const model = createLockoutCounterModel();
    const key = lockoutCounterKey({ kind: "account", subject: "user-1" });
    let last = 0;
    for (let i = 0; i < ATTEMPTS; i++) {
      last = model.recordFailure(key);
    }
    expect(last).toBe(ATTEMPTS);
    expect(model.peek(key)).toBe(ATTEMPTS);
  });

  test("increments scheduled concurrently still land an exact count (no interleaving)", async () => {
    const model = createLockoutCounterModel();
    const key = lockoutCounterKey({ kind: "account", subject: "user-2" });
    await Promise.all(
      Array.from({ length: ATTEMPTS }, () =>
        Promise.resolve().then(() => model.recordFailure(key))
      )
    );
    // Every increment landed — but ONLY because a synchronous read-modify-write in
    // single-threaded JS cannot interleave. This illustrates the design principle
    // (a serialized RMW is exact); it is NOT the DO's runtime per-instance gating.
    expect(model.peek(key)).toBe(ATTEMPTS);
  });

  test("the returned post-increment values form the exact 1..N sequence", () => {
    const model = createLockoutCounterModel();
    const key = lockoutCounterKey({ kind: "ip", subject: "203.0.113.7" });
    const seen = Array.from({ length: ATTEMPTS }, () =>
      model.recordFailure(key)
    );
    expect(seen).toEqual(
      Array.from({ length: ATTEMPTS }, (_unused, i) => i + 1)
    );
  });
});

describe("per-account and per-IP perimeters are DISTINCT counters", () => {
  test("the same subject on the account vs IP perimeter never shares a counter", () => {
    const model = createLockoutCounterModel();
    const subject = "shared-subject";
    const accountKey = lockoutCounterKey({ kind: "account", subject });
    const ipKey = lockoutCounterKey({ kind: "ip", subject });

    // The keys are structurally distinct — the load-bearing separateness.
    expect(accountKey).not.toBe(ipKey);

    model.recordFailure(accountKey);
    model.recordFailure(accountKey);
    model.recordFailure(ipKey);

    // Incrementing one perimeter never bleeds into the other.
    expect(model.peek(accountKey)).toBe(2);
    expect(model.peek(ipKey)).toBe(1);
  });

  test("resetting one perimeter leaves the other perimeter's count intact", () => {
    const model = createLockoutCounterModel();
    const subject = "user-3";
    const accountKey = lockoutCounterKey({ kind: "account", subject });
    const ipKey = lockoutCounterKey({ kind: "ip", subject });
    model.recordFailure(accountKey);
    model.recordFailure(ipKey);
    model.reset(accountKey);
    expect(model.peek(accountKey)).toBe(0);
    expect(model.peek(ipKey)).toBe(1);
  });
});
