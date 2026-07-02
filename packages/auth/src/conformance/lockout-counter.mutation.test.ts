// Mutation twin for lockout-counter.gate.test.ts.
//
// The gate DEMONSTRATES the design principle "a serialized read-modify-write is
// exact". The easy way to fake that demonstration is to never actually exercise
// concurrency. This twin forecloses it: it drives the shipped DO's RMW SHAPE (an
// async read-modify-write) WITHOUT the Durable Object platform's per-instance gating
// — `recordFailure` awaits BETWEEN the read and the write. Two increments scheduled
// via Promise.all both read the same stale value and both write stale+1, so the final
// count is LESS than the number of increments. This is the contrapositive: the same
// async RMW the DO ships loses updates once the platform's serialization is removed —
// so the shipped DO's async RMW is correct ONLY under that platform serialization
// (relied upon at runtime, not reproduced here). The twin asserts the exact-count
// assertion reddens on this naive lossy counter while the deterministic in-memory
// model stays exact under the identical driver.

import { createLockoutCounterModel } from "@perry-starter/auth/lockout-counter-model";
import { lockoutCounterKey } from "@perry-starter/auth/lockout-seam";
import { describe, expect, test } from "vitest";

const ATTEMPTS = 25;

// A NON-serialized counter: it reads, YIELDS (await), then writes stale+1. Under
// concurrent scheduling the yields interleave so updates are lost — the exact hazard
// the Durable Object PLATFORM's per-instance RPC gating prevents at runtime.
const createLossyCounter = () => {
  const counts = new Map<string, number>();
  return {
    peek: (key: string): number => counts.get(key) ?? 0,
    recordFailure: async (key: string): Promise<number> => {
      const read = counts.get(key) ?? 0; // read
      await Promise.resolve(); // yield -> other increments observe the same stale read
      const next = read + 1;
      counts.set(key, next); // write stale + 1
      return next;
    },
  };
};

describe("the exact-count check reddens on a non-serialized (lossy) counter", () => {
  test("the lossy counter loses updates under concurrent scheduling", async () => {
    const lossy = createLossyCounter();
    const key = lockoutCounterKey({ kind: "account", subject: "user-1" });
    await Promise.all(
      Array.from({ length: ATTEMPTS }, () => lossy.recordFailure(key))
    );
    // The lost-update hazard fired: the final count is strictly below the number of
    // increments — so the gate's `toBe(ATTEMPTS)` assertion would FAIL here.
    expect(lossy.peek(key)).toBeLessThan(ATTEMPTS);
  });

  test("the REAL serialized model stays exact under the identical driver", async () => {
    const model = createLockoutCounterModel();
    const key = lockoutCounterKey({ kind: "account", subject: "user-1" });
    await Promise.all(
      Array.from({ length: ATTEMPTS }, () =>
        Promise.resolve().then(() => model.recordFailure(key))
      )
    );
    expect(model.peek(key)).toBe(ATTEMPTS);
  });
});
