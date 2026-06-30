// Conformance gate — cross-surface response invariance (anti-enumeration), driven
// on the PRODUCTION wrapper.
//
// This drives the REAL `auth.handler` (over an isolated in-memory adapter) wrapped
// by the production `normalizeAuthResponse` — the exact ingress the worker fronts —
// across the five-state email matrix materialized as REAL divergent accounts. It
// asserts every pre-auth surface (sign-up, verification-resend) is byte-identical
// across the matrix and equals the ONE neutral envelope single-sourced in
// packages/db, and that none leaks an existence/state token. Its paired
// `*.mutation.test.ts` twin proves the SAME checker reddens AND that the raw
// (un-normalized) responses leak — so the wrapper is load-bearing.

import { neutralAuthEnvelope } from "@perry-starter/db/auth/neutral-response";
import { afterEach, describe, expect, test } from "vitest";
import {
  resendVerification,
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

afterEach(() => {
  resetAuthHarness();
});

describe("pre-auth surfaces reuse the single neutral envelope across the email matrix", () => {
  test("sign-up and verification-resend are byte-identical and equal the db envelope for every state", async () => {
    const fixtures = await seedEmailMatrix([...EMAIL_MATRIX]);
    const signUps: SurfaceResponse[] = [];
    const resends: SurfaceResponse[] = [];
    for (const state of EMAIL_MATRIX) {
      const email = fixtures[state];
      const signUpResponse = await signUp(email);
      const resendResponse = await resendVerification(email);
      // Each surface carries the neutral envelope's status + body (existence and
      // verification-state are never revealed).
      expect(signUpResponse.status).toBe(neutralAuthEnvelope.status);
      expect(signUpResponse.body).toEqual(neutralAuthEnvelope.body);
      expect(resendResponse.status).toBe(neutralAuthEnvelope.status);
      expect(resendResponse.body).toEqual(neutralAuthEnvelope.body);
      signUps.push(signUpResponse);
      resends.push(resendResponse);
    }
    // …and byte-identical to one another across the whole matrix.
    expect(allByteIdentical(signUps)).toBe(true);
    expect(allByteIdentical(resends)).toBe(true);
  });

  test("no pre-auth response leaks an existence or state token", async () => {
    const fixtures = await seedEmailMatrix([...EMAIL_MATRIX]);
    for (const state of EMAIL_MATRIX) {
      const email = fixtures[state];
      const signUpResponse = await signUp(email);
      const resendResponse = await resendVerification(email);
      expect(revealsExistenceOrState(signUpResponse.body)).toBe(false);
      expect(revealsExistenceOrState(resendResponse.body)).toBe(false);
    }
  });
});
