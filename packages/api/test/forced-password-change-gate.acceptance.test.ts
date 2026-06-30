// Acceptance — the forced-password-change gate enforced on the REAL tRPC
// middleware (an in-process caller exercising the actual `.use()` leg, not a
// hand-rolled double):
//
//   - a flagged account is denied on every op except change-password, with the
//     nearest native FORBIDDEN code, the precise PASSWORD_CHANGE_REQUIRED code in
//     the error envelope's data.code, and the x-require-password-change signal
//     header set on the response leg;
//   - the change-password op is the ONE permitted forward path while flagged, so
//     the gate is never a dead-end;
//   - an unflagged account is unaffected, and the signal header is NOT set when an
//     op is allowed (so the deny test is not vacuously setting it everywhere).

import { createForcedChangeCaller, toErrorShape } from "@perry-starter/api";
import { REQUIRE_PASSWORD_CHANGE_HEADER } from "@perry-starter/auth/forced-password-change";
import { describe, expect, test } from "vitest";

interface CapturedError {
  readonly dataCode?: string;
  readonly nativeCode?: string;
}

const flaggedCtx = () => ({
  resHeaders: new Headers(),
  session: { user: { id: "u1", requirePasswordChange: true } },
});

const unflaggedCtx = () => ({
  resHeaders: new Headers(),
  session: { user: { id: "u1", requirePasswordChange: false } },
});

describe("a flagged account is blocked from everything except change-password", () => {
  test("a non-change-password op is denied with FORBIDDEN, the precise envelope code, and the signal header", async () => {
    const ctx = flaggedCtx();
    const caller = createForcedChangeCaller(ctx);
    let captured: CapturedError | undefined;
    try {
      await caller.listDocuments();
    } catch (error) {
      captured = toErrorShape(error);
    }
    expect(captured).toBeDefined();
    expect((captured as CapturedError).nativeCode).toBe("FORBIDDEN");
    expect((captured as CapturedError).dataCode).toBe(
      "PASSWORD_CHANGE_REQUIRED"
    );
    expect(ctx.resHeaders.get(REQUIRE_PASSWORD_CHANGE_HEADER)).toBe("1");
  });

  test("the change-password op is allowed even while flagged — the one forward path", async () => {
    const ctx = flaggedCtx();
    const caller = createForcedChangeCaller(ctx);
    await expect(caller.changePassword()).resolves.toEqual({ changed: true });
    expect(ctx.resHeaders.get(REQUIRE_PASSWORD_CHANGE_HEADER)).toBeNull();
  });
});

describe("an unflagged account is unaffected by the gate", () => {
  test("every op is allowed and the signal header is never set", async () => {
    const ctx = unflaggedCtx();
    const caller = createForcedChangeCaller(ctx);
    await expect(caller.listDocuments()).resolves.toEqual({ documents: [] });
    await expect(caller.changePassword()).resolves.toEqual({ changed: true });
    expect(ctx.resHeaders.get(REQUIRE_PASSWORD_CHANGE_HEADER)).toBeNull();
  });
});
