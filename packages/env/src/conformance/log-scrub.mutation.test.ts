import { describe, expect, test } from "vitest";

// Mutation twin for log-scrub.gate.test.ts. It plants the two ways a scrubber can
// silently leak and proves each reddens the gate's "the secret is removed"
// expectation, with a clean control on the correct recursive scrubber.
//
// The denied field under test is `password` (value "hunter2"): the gate asserts
// it is redacted; a non-scrubbing variant leaves it verbatim → red; a top-level-
// only variant misses the NESTED secret → red.

const REDACTED = "[redacted]";
const DENIED_KEY_SUBSTRINGS = [
  "authorization",
  "password",
  "secret",
  "token",
  "cookie",
  "apikey",
  "api-key",
];

const record = () => ({
  message: "auth.sign_in",
  actor: "user_01",
  password: "hunter2",
  headers: { apiKey: "ak-secret" },
});

const isSecretKey = (key: string): boolean => {
  const lowered = key.toLowerCase();
  return DENIED_KEY_SUBSTRINGS.some((needle) => lowered.includes(needle));
};

// The CORRECT recursive scrubber — the behavior the shipped impl must match.
const correctScrub = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(correctScrub);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>
    )) {
      out[key] = isSecretKey(key) ? REDACTED : correctScrub(nested);
    }
    return out;
  }
  return value;
};

describe("a non-scrubbing scrubber variant leaks the denied field the gate expects removed", () => {
  test("an identity (pass-through) scrubber leaks `password` verbatim → the gate's redaction expectation reddens", () => {
    const identityScrub = <T>(value: T): T => value;
    const leaked = identityScrub(record());

    // The gate asserts scrubbed.password === REDACTED; here it is the raw secret.
    expect(leaked.password).toBe("hunter2");
    expect(leaked.password).not.toBe(REDACTED);
    expect(JSON.stringify(leaked)).toContain("hunter2");
  });

  test("a TOP-LEVEL-ONLY scrubber misses the nested apiKey → the nested-redaction expectation reddens", () => {
    const shallowScrub = (
      value: Record<string, unknown>
    ): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value)) {
        out[key] = isSecretKey(key) ? REDACTED : nested; // no recursion
      }
      return out;
    };
    const scrubbed = shallowScrub(record()) as {
      password: string;
      headers: { apiKey: string };
    };

    // Top-level password IS redacted, but the nested secret leaks.
    expect(scrubbed.password).toBe(REDACTED);
    expect(scrubbed.headers.apiKey).toBe("ak-secret");
    expect(JSON.stringify(scrubbed)).toContain("ak-secret");
  });

  test("the CORRECT recursive scrubber removes both the top-level and nested secrets (not always-red control)", () => {
    const scrubbed = correctScrub(record()) as {
      password: string;
      headers: { apiKey: string };
      message: string;
    };

    expect(scrubbed.password).toBe(REDACTED);
    expect(scrubbed.headers.apiKey).toBe(REDACTED);
    expect(scrubbed.message).toBe("auth.sign_in"); // benign field survives
    expect(JSON.stringify(scrubbed)).not.toContain("hunter2");
    expect(JSON.stringify(scrubbed)).not.toContain("ak-secret");
  });
});
