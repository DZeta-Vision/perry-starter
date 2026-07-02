import { describe, expect, test } from "vitest";

import {
  initialStepUpState,
  type PausedAction,
  type StepUpEffect,
  stepUpReducer,
} from "./step-up-controller";

// The step-up pause/resume controller: on grant it resumes the SAME paused action
// with its original args; cancel and a second failure abort ONLY the action. No
// transition ever emits a session-scoped effect — a step-up mis-step can never
// self-inflict a full logout / lost work.

interface RoleArgs {
  role: string;
  userId: string;
}
const PENDING: PausedAction<RoleArgs> = {
  action: "role.change",
  args: { role: "member", userId: "u9" },
};

describe("the step-up controller pauses, resumes, and never touches the session", () => {
  test("a challenge captures the paused action", () => {
    const { state, effect } = stepUpReducer(initialStepUpState<RoleArgs>(), {
      pending: PENDING,
      type: "challenge",
    });
    expect(state.status).toBe("challenging");
    expect(state.pending).toEqual(PENDING);
    expect(effect.kind).toBe("none");
  });

  test("a grant resumes the SAME action with its ORIGINAL args + the fresh token", () => {
    const challenged = stepUpReducer(initialStepUpState<RoleArgs>(), {
      pending: PENDING,
      type: "challenge",
    }).state;
    const { state, effect } = stepUpReducer(challenged, {
      token: "fresh-grant-token",
      type: "grant",
    });
    expect(state.status).toBe("resuming");
    expect(state.pending).toBeUndefined(); // consumed
    expect(effect.kind).toBe("resume-action");
    if (effect.kind === "resume-action") {
      expect(effect.action.args).toEqual(PENDING.args); // resumes where it stopped
      expect(effect.token).toBe("fresh-grant-token");
    }
  });

  test("a first failure re-challenges and retains the pending action (no session effect)", () => {
    const challenged = stepUpReducer(initialStepUpState<RoleArgs>(), {
      pending: PENDING,
      type: "challenge",
    }).state;
    const { state, effect } = stepUpReducer(challenged, { type: "fail" });
    expect(state.status).toBe("challenging");
    expect(state.failureCount).toBe(1);
    expect(state.pending).toEqual(PENDING);
    expect(effect.kind).toBe("none");
  });

  test("a second failure aborts the ACTION (never the session)", () => {
    let state = stepUpReducer(initialStepUpState<RoleArgs>(), {
      pending: PENDING,
      type: "challenge",
    }).state;
    state = stepUpReducer(state, { type: "fail" }).state;
    const second = stepUpReducer(state, { type: "fail" });
    expect(second.state.status).toBe("aborted");
    expect(second.state.pending).toBeUndefined();
    expect(second.effect.kind).toBe("abort-action");
  });

  test("cancel aborts ONLY the action — the pending action is cleared, no session effect", () => {
    const challenged = stepUpReducer(initialStepUpState<RoleArgs>(), {
      pending: PENDING,
      type: "challenge",
    }).state;
    const { state, effect } = stepUpReducer(challenged, { type: "cancel" });
    expect(state.status).toBe("aborted");
    expect(state.pending).toBeUndefined();
    expect(effect.kind).toBe("abort-action");
  });

  test("NO event ever produces a session-scoped effect", () => {
    const events = [
      { pending: PENDING, type: "challenge" as const },
      { token: "t", type: "grant" as const },
      { type: "fail" as const },
      { type: "cancel" as const },
    ];
    const kinds = new Set<StepUpEffect<RoleArgs>["kind"]>();
    let state = initialStepUpState<RoleArgs>();
    for (const event of events) {
      const next = stepUpReducer(state, event);
      kinds.add(next.effect.kind);
      state = next.state;
    }
    // The effect vocabulary is closed to none | resume-action | abort-action — no
    // "revoke-session" variant exists, so the session can never be killed here.
    for (const kind of kinds) {
      expect(["none", "resume-action", "abort-action"]).toContain(kind);
    }
  });
});
