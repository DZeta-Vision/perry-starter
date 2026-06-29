// The auth-authority audit sink — INJECTED, never imported.
//
// packages/auth carries no logging dependency: the worker tier wires the real
// sink (pino + Sentry) at boot via `configureAuthAudit`, and tests inject a
// capturing sink. The default is a safe no-op so a missing wiring never throws and
// the package stays SDK-free. The fail-open HIBP screen and the verification-email
// dispatch both record through this sink, so an operator sees `auth.hibp_fallback`
// and `auth.verification_email_*` on the cloud authority.

export type AuthAuditSink = (action: string) => void;

const NOOP_SINK: AuthAuditSink = () => undefined;

let sink: AuthAuditSink = NOOP_SINK;

export const configureAuthAudit = (next: AuthAuditSink): void => {
  sink = next;
};

export const resetAuthAudit = (): void => {
  sink = NOOP_SINK;
};

export const recordAuthAudit = (action: string): void => {
  sink(action);
};
