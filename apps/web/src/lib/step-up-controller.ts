// The step-up pause/resume controller — a PURE state machine over a paused action.
//
// When a dangerous mutation returns STEP_UP_REQUIRED, the client PAUSES the action
// (captures the call + its args), raises the step-up modal, and on a granted re-auth
// RESUMES the SAME action exactly where it stopped (the original args, plus the
// fresh grant token). Cancel aborts ONLY the action; a second failure aborts ONLY
// the action. The machine NEVER emits a session-scoped effect — the session is
// never revoked by a step-up cancel/failure (so a mis-step can never self-inflict a
// full logout / lost work).
//
// It is pure (no React, no network): the reducer maps (state, event) -> (state,
// effect) so the UX behavior is driven deterministically in tests, and the host
// binds the effect to the real re-auth + resume.

// The paused action: an opaque descriptor of the mutation to resume, carrying its
// ORIGINAL arguments so the resume runs exactly where it stopped.
export interface PausedAction<Args = unknown> {
  readonly action: string;
  readonly args: Args;
}

export type StepUpStatus = "idle" | "challenging" | "resuming" | "aborted";

export interface StepUpState<Args = unknown> {
  readonly failureCount: number;
  readonly pending: PausedAction<Args> | undefined;
  readonly status: StepUpStatus;
}

// The effect the host performs. Deliberately NO "revoke-session" variant exists —
// the session is out of scope for step-up, so the type system forecloses a
// session-killing effect.
export type StepUpEffect<Args = unknown> =
  | {
      readonly kind: "resume-action";
      readonly action: PausedAction<Args>;
      readonly token: string;
    }
  | { readonly kind: "abort-action" }
  | { readonly kind: "none" };

export type StepUpEvent<Args = unknown> =
  | { readonly type: "challenge"; readonly pending: PausedAction<Args> }
  | { readonly type: "grant"; readonly token: string }
  | { readonly type: "fail" }
  | { readonly type: "cancel" };

// The fail-twice ceiling (mirrors the server's STEP_UP_MAX_ATTEMPTS): a second
// failure aborts the action.
export const STEP_UP_MAX_ATTEMPTS = 2;

export const initialStepUpState = <Args = unknown>(): StepUpState<Args> => ({
  status: "idle",
  pending: undefined,
  failureCount: 0,
});

export interface StepUpTransition<Args = unknown> {
  readonly effect: StepUpEffect<Args>;
  readonly state: StepUpState<Args>;
}

// The reducer. Cancel and fail-twice both clear the pending action and settle to a
// non-session effect; a grant resumes the paused action with its original args.
export const stepUpReducer = <Args = unknown>(
  state: StepUpState<Args>,
  event: StepUpEvent<Args>
): StepUpTransition<Args> => {
  switch (event.type) {
    case "challenge":
      return {
        state: {
          status: "challenging",
          pending: event.pending,
          failureCount: 0,
        },
        effect: { kind: "none" },
      };
    case "grant": {
      // Resume the SAME paused action with its original args + the fresh grant. If
      // nothing is pending, there is nothing to resume (defensive no-op).
      if (!state.pending) {
        return { state, effect: { kind: "none" } };
      }
      return {
        state: { status: "resuming", pending: undefined, failureCount: 0 },
        effect: {
          kind: "resume-action",
          action: state.pending,
          token: event.token,
        },
      };
    }
    case "fail": {
      const failureCount = state.failureCount + 1;
      // A second failure aborts the ACTION — never the session.
      if (failureCount >= STEP_UP_MAX_ATTEMPTS) {
        return {
          state: { status: "aborted", pending: undefined, failureCount },
          effect: { kind: "abort-action" },
        };
      }
      // A first failure re-challenges — the pending action is retained.
      return {
        state: { ...state, status: "challenging", failureCount },
        effect: { kind: "none" },
      };
    }
    case "cancel":
      // Cancel aborts ONLY the action — the pending action is cleared, the session
      // is untouched.
      return {
        state: { status: "aborted", pending: undefined, failureCount: 0 },
        effect: { kind: "abort-action" },
      };
    default:
      return { state, effect: { kind: "none" } };
  }
};
