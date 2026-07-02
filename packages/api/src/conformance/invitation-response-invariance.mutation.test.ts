// Mutation twin for invitation-response-invariance.gate.test.ts.
//
// Two reddening directions, both against the SAME shared detectors the gate uses:
//  (1) a REVEALING invitation surface builder — one that branches the body on
//      whether the email is already an account — is NOT byte-identical across the
//      matrix and leaks an existence token, so the checker reddens; the production
//      single-return surface stays byte-identical. If the surface stopped collapsing
//      to the one envelope, the gate's invariant would break — so it cannot be
//      vacuously green.
//  (2) a status/header divergence on any one surface reddens the byte-identity check.

import {
  allByteIdentical,
  EMAIL_MATRIX,
  revealsExistenceOrState,
  type SurfaceResponse,
} from "@perry-starter/auth/conformance/response-invariance";
import { expect, test } from "vitest";

import { INVITATION_SURFACE_RESPONSE } from "../invitation-surface";

const NEUTRAL: SurfaceResponse = INVITATION_SURFACE_RESPONSE;

// A REVEALING surface builder: it branches the body on whether the email is already
// an account — exactly the leak the production single-return forecloses. Defined
// only here so the twin proves the SAME checker reddens on it.
const revealingSurfaceResponse = (accountExists: boolean): SurfaceResponse =>
  accountExists
    ? {
        ...NEUTRAL,
        body: { message: "auth.invitation.email_already_registered" },
      }
    : NEUTRAL;

test("the production surface is byte-identical while the revealing surface is not", () => {
  const production = EMAIL_MATRIX.map(() => INVITATION_SURFACE_RESPONSE);
  expect(allByteIdentical(production)).toBe(true);

  const revealing = EMAIL_MATRIX.map((state) =>
    revealingSurfaceResponse(state === "registered")
  );
  expect(allByteIdentical(revealing)).toBe(false);
});

test("a status or header divergence on one surface reddens the checker", () => {
  const statusDrift = EMAIL_MATRIX.map((state) =>
    state === "unregistered" ? { ...NEUTRAL, status: 404 } : NEUTRAL
  );
  const headerDrift = EMAIL_MATRIX.map((state) =>
    state === "verified"
      ? {
          ...NEUTRAL,
          headers: { ...NEUTRAL.headers, "x-account-state": "verified" },
        }
      : NEUTRAL
  );
  expect(allByteIdentical(statusDrift)).toBe(false);
  expect(allByteIdentical(headerDrift)).toBe(false);
});

test("an existence token in a revealing body is detected; the neutral body is not", () => {
  expect(revealsExistenceOrState(revealingSurfaceResponse(true).body)).toBe(
    true
  );
  expect(revealsExistenceOrState(INVITATION_SURFACE_RESPONSE.body)).toBe(false);
});
