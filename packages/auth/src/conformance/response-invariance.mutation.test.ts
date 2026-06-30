// Mutation twin for the response-invariance gate (anti-vacuous proof).
//
// Two reddening directions:
//  (1) the gate's OWN single-sourced checker reddens on a revealing surface — a
//      divergent registered case is NOT byte-identical and a leaked existence/state
//      token IS detected;
//  (2) the production wrapper is LOAD-BEARING — the RAW (un-normalized)
//      `auth.handler` sign-up responses across the matrix are NOT byte-identical
//      (they embed the submitted email) and reveal existence, while the normalized
//      responses are byte-identical. If the worker stopped normalizing, the gate's
//      invariant would break — so the gate cannot be vacuously green.

import { afterEach, describe, expect, test } from "vitest";
import {
  rawSignUp,
  resetAuthHarness,
  seedEmailMatrix,
  signUp,
} from "../test-harness";
import {
  allByteIdentical,
  EMAIL_MATRIX,
  revealsExistenceOrState,
  type SurfaceResponse,
} from "./response-invariance";

const NEUTRAL: SurfaceResponse = {
  body: { message: "auth.verification.maybe_sent" },
  headers: { "content-type": "application/json" },
  status: 200,
};

afterEach(() => {
  resetAuthHarness();
});

describe("the response-invariance checker reddens on a revealing surface", () => {
  test("a body that diverges for the registered case is NOT byte-identical", () => {
    const matrix = EMAIL_MATRIX.map((state) =>
      state === "registered"
        ? { ...NEUTRAL, body: { message: "auth.email.already_registered" } }
        : { ...NEUTRAL }
    );
    expect(allByteIdentical(matrix)).toBe(false);
  });

  test("a status or header that diverges is NOT byte-identical", () => {
    const statusDrift = EMAIL_MATRIX.map((state) =>
      state === "unregistered" ? { ...NEUTRAL, status: 404 } : { ...NEUTRAL }
    );
    const headerDrift = EMAIL_MATRIX.map((state) =>
      state === "verified"
        ? {
            ...NEUTRAL,
            headers: { ...NEUTRAL.headers, "x-account-state": "verified" },
          }
        : { ...NEUTRAL }
    );
    expect(allByteIdentical(statusDrift)).toBe(false);
    expect(allByteIdentical(headerDrift)).toBe(false);
  });

  test("a leaked EMAIL_NOT_VERIFIED or existence token in a pre-auth body is detected", () => {
    expect(revealsExistenceOrState({ code: "EMAIL_NOT_VERIFIED" })).toBe(true);
    expect(revealsExistenceOrState({ error: "user already exists" })).toBe(
      true
    );
    expect(
      revealsExistenceOrState({ message: "auth.verification.maybe_sent" })
    ).toBe(false);
  });
});

describe("the production normalizer is load-bearing on the real ingress", () => {
  test("raw sign-up responses leak across the matrix while normalized ones do not", async () => {
    const fixtures = await seedEmailMatrix([...EMAIL_MATRIX]);
    const raw: SurfaceResponse[] = [];
    const normalized: SurfaceResponse[] = [];
    for (const state of EMAIL_MATRIX) {
      const email = fixtures[state];
      raw.push(await rawSignUp(email));
      normalized.push(await signUp(email));
    }
    // The raw better-auth responses embed the submitted email, so they DIVERGE by
    // state and at least one reveals the submitted address — the leak the wrapper
    // must close.
    expect(allByteIdentical(raw)).toBe(false);
    expect(
      raw.some((response) =>
        JSON.stringify(response.body ?? null)
          .toUpperCase()
          .includes("UNREGISTERED@MATRIX.EXAMPLE.COM")
      )
    ).toBe(true);
    // With the production wrapper, every surface collapses to the one envelope.
    expect(allByteIdentical(normalized)).toBe(true);
  });
});
