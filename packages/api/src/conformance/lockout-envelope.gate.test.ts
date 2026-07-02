// Conformance gate — the progressive-lockout server envelope. It proves BOTH legs
// of the ACCOUNT_LOCKED surface the client already consumes:
//   - the tRPC leg: `buildLockoutError` throws the VALID native code
//     TOO_MANY_REQUESTS (-> HTTP 429), and the SHIPPED root errorFormatter (the one
//     `../index` `t` uses, driven here through tRPC's real `getErrorShape`) folds
//     ACCOUNT_LOCKED + retryAfter into shape.data (ACCOUNT_LOCKED is NOT a native
//     tRPC code, so it rides the envelope). This exercises the real shipped path, not
//     a throwaway per-leg tRPC instance.
//   - the REST-ingress leg: `buildLockoutResponse` is a 429 carrying the literal
//     `Retry-After` header AND a body `{ code: "ACCOUNT_LOCKED", retryAfter }` — the
//     shape `apps/web` `authCodeFromEnvelope` reads.
// The mutation twin (lockout-envelope.mutation.test.ts) drives a vacuous errorFormatter
// that stamps ACCOUNT_LOCKED on ANY error and a response that drops the Retry-After
// header, and asserts the SAME checks redden.

import { getErrorShape, TRPCError } from "@trpc/server";
import { describe, expect, test } from "vitest";

import { t } from "../index";
import {
  ACCOUNT_LOCKED_CODE,
  buildLockoutError,
  buildLockoutResponse,
  lockoutDataForError,
  RETRY_AFTER_HEADER,
  TOO_MANY_REQUESTS_STATUS,
} from "../lockout-envelope";

const RETRY_AFTER = 900;

// Run the SHIPPED root errorFormatter over a thrown error, exactly as a tRPC server
// adapter does at request time — so the assertions cover the real wired projection.
const shipShape = (error: TRPCError, path: string | undefined) =>
  getErrorShape({
    config: t._config,
    ctx: undefined,
    error,
    input: undefined,
    path,
    type: "mutation",
  });

describe("the tRPC leg carries a valid native code and rides ACCOUNT_LOCKED in shape.data", () => {
  test("buildLockoutError carries the valid native TOO_MANY_REQUESTS code (-> 429)", () => {
    expect(buildLockoutError(RETRY_AFTER).code).toBe("TOO_MANY_REQUESTS");
  });

  test("the SHIPPED errorFormatter surfaces ACCOUNT_LOCKED + retryAfter into shape.data", () => {
    const shape = shipShape(buildLockoutError(RETRY_AFTER), "auth.signIn");
    expect(shape.data.code).toBe(ACCOUNT_LOCKED_CODE);
    expect((shape.data as { retryAfter?: number }).retryAfter).toBe(
      RETRY_AFTER
    );
  });

  test("a non-lockout error keeps its native code and rides NO ACCOUNT_LOCKED/retryAfter", () => {
    const shape = shipShape(new TRPCError({ code: "FORBIDDEN" }), "admin.op");
    expect(shape.data.code).toBe("FORBIDDEN");
    expect((shape.data as { retryAfter?: number }).retryAfter).toBeUndefined();
  });

  test("the shipped projection helper matches what the errorFormatter folds", () => {
    // The EXACT function the root errorFormatter folds into shape.data.
    expect(lockoutDataForError(buildLockoutError(RETRY_AFTER))).toEqual({
      code: ACCOUNT_LOCKED_CODE,
      retryAfter: RETRY_AFTER,
    });
    expect(lockoutDataForError(new TRPCError({ code: "FORBIDDEN" }))).toEqual(
      {}
    );
    expect(lockoutDataForError(new Error("plain"))).toEqual({});
  });
});

describe("the REST-ingress leg is a 429 with a literal Retry-After header + ACCOUNT_LOCKED body", () => {
  test("the response status is 429 and the literal Retry-After header equals the window seconds", async () => {
    const res = buildLockoutResponse(RETRY_AFTER);
    expect(res.status).toBe(TOO_MANY_REQUESTS_STATUS);
    expect(res.headers.get(RETRY_AFTER_HEADER)).toBe(String(RETRY_AFTER));
    const body = (await res.json()) as { code: string; retryAfter: number };
    expect(body.code).toBe(ACCOUNT_LOCKED_CODE);
    expect(body.retryAfter).toBe(RETRY_AFTER);
  });

  test("the body code is the generic ACCOUNT_LOCKED (no numeric copy, identical for locked/rate-limited)", async () => {
    const res = buildLockoutResponse(1);
    const body = (await res.json()) as { code: string };
    // The client maps THIS code to the account-locked treatment; the copy is the
    // client's generic non-numeric string, never a rendered countdown.
    expect(body.code).toBe(ACCOUNT_LOCKED_CODE);
  });
});
