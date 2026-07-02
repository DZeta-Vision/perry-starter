// Mutation twin for lockout-envelope.gate.test.ts.
//
// The gate trusts three load-bearing facts driven through the SHIPPED path: (1) the
// root errorFormatter surfaces ACCOUNT_LOCKED + retryAfter for a genuine lockout
// cause, (2) a non-lockout error keeps its native code and rides NO ACCOUNT_LOCKED,
// and (3) the REST 429 carries a literal Retry-After header. This twin builds a
// vacuous errorFormatter that stamps ACCOUNT_LOCKED on ANY error, a projection that
// drops retryAfter, and a response that drops the Retry-After header, and asserts the
// SAME checks the gate makes would redden — while the REAL wiring stays correct.

import type { AnyTRPCRootTypes, TRPCRootConfig } from "@trpc/server";
import { getErrorShape, initTRPC, TRPCError } from "@trpc/server";
import { describe, expect, test } from "vitest";

import { t } from "../index";
import {
  ACCOUNT_LOCKED_CODE,
  buildLockoutError,
  lockoutDataForError,
  RETRY_AFTER_HEADER,
} from "../lockout-envelope";

// A BROKEN root instance whose errorFormatter stamps ACCOUNT_LOCKED regardless of the
// error's cause — the vacuous-projection hazard the gate forecloses.
const tVacuous = initTRPC.create({
  errorFormatter: ({ shape }) => ({
    ...shape,
    data: { ...shape.data, code: ACCOUNT_LOCKED_CODE },
  }),
});

const shapeFrom = <TRoot extends AnyTRPCRootTypes>(
  config: TRPCRootConfig<TRoot>
) =>
  getErrorShape({
    config,
    ctx: undefined,
    error: new TRPCError({ code: "FORBIDDEN" }),
    input: undefined,
    path: "admin.op",
    type: "mutation",
  });

// A BROKEN response builder: a 429 that FORGETS the literal Retry-After header.
const responseWithoutRetryAfter = (): Response =>
  Response.json({ code: ACCOUNT_LOCKED_CODE }, { status: 429 });

describe("the non-vacuous-projection check reddens on an unconditional stamper", () => {
  test("the vacuous errorFormatter wrongly stamps ACCOUNT_LOCKED onto an unrelated FORBIDDEN", () => {
    // The gate asserts a FORBIDDEN keeps code === "FORBIDDEN"; a stamper that ignores
    // the cause returns ACCOUNT_LOCKED, so that gate assertion would fail here.
    expect(shapeFrom(tVacuous._config).data.code).toBe(ACCOUNT_LOCKED_CODE);
  });

  test("the REAL shipped errorFormatter keeps FORBIDDEN native (keys on the cause)", () => {
    expect(shapeFrom(t._config).data.code).toBe("FORBIDDEN");
  });

  test("the REAL projection still surfaces ACCOUNT_LOCKED + retryAfter for a genuine lockout error", () => {
    expect(lockoutDataForError(buildLockoutError(60))).toEqual({
      code: ACCOUNT_LOCKED_CODE,
      retryAfter: 60,
    });
  });

  test("a projection that DROPS retryAfter reddens the retryAfter assertion", () => {
    const droppingProjection = (): { code: string } => ({
      code: ACCOUNT_LOCKED_CODE,
    });
    // The gate asserts shape.data.retryAfter === the window; a projection that omits
    // it leaves retryAfter undefined, so that assertion would fail.
    expect(
      (droppingProjection() as { retryAfter?: number }).retryAfter
    ).toBeUndefined();
  });
});

describe("the Retry-After-header check reddens when the header is dropped", () => {
  test("the broken response is missing the literal Retry-After header", () => {
    const res = responseWithoutRetryAfter();
    expect(res.headers.get(RETRY_AFTER_HEADER)).toBeNull();
  });
});
