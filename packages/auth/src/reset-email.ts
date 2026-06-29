// Bilingual (FR/EN) Resend password-reset email dispatch wrapper.
//
// Worker-tier dispatch logic that is deliberately SDK-FREE: it NEVER imports the
// Resend SDK (that import is worker-only). The actual `send` is injected — the
// worker wires the real `resend.emails.send`; tests inject a capture double. The
// Resend result is a discriminated union that NEVER throws on an API error, so we
// destructure `{ data, error }` and handle `error` FIRST, never leaking
// provider/stack detail and never throwing out of the send path. The dispatch is
// out-of-band so it never perturbs the byte-identical neutral reset-request
// response or its timing.
//
// The template is the `perry-reset-password` react-email component; the FR/EN
// catalog is activated off the account `locale` at render time (keyed off the
// prop, no request context).

import { LOCALE_DEFAULT } from "@perry-starter/db/shapes/identity";
import type { SendResult } from "./verification-email";

// The reset-token lifetime better-auth is configured with — the explicit 30-min
// value (distinct from the 1h email-verification TTL). Single-sourced here so the
// auth config and the pure reset-token spec agree (the spec derives its ms value
// from this).
export const RESET_PASSWORD_TOKEN_TTL_SECONDS = 30 * 60;

// The react-email template id keyed off the account locale.
export const RESET_PASSWORD_EMAIL_TEMPLATE = "perry-reset-password";

export interface ResetEmailVariables {
  readonly locale: string;
  readonly resetToken: string;
  readonly resetUrl: string;
}

export interface ResetEmailIntent {
  readonly locale: string;
  readonly subject: string;
  readonly template: typeof RESET_PASSWORD_EMAIL_TEMPLATE;
  readonly to: string;
  readonly variables: ResetEmailVariables;
}

export type ResetEmailSender = (
  intent: ResetEmailIntent
) => Promise<SendResult>;

export interface ResetDispatchDeps {
  readonly audit: (action: string) => void;
  readonly send: ResetEmailSender;
}

export interface ResetDispatchedRecord {
  readonly error: SendResult["error"];
  readonly locale: string;
  readonly template: string;
  readonly variables: ResetEmailVariables;
}

// Bilingual subject keyed off the account locale — proves the locale var is
// actually consumed (an FR account never receives EN copy).
const localizedSubject = (locale: string): string =>
  locale === "fr"
    ? "email.reset_password.subject.fr"
    : "email.reset_password.subject.en";

// Dispatch the reset email. The send error is destructured and handled first; the
// path never throws. Returns what was dispatched (for audit/log), with the error
// surfaced as data — never re-thrown.
export const dispatchResetEmail = async (
  input: {
    readonly locale?: string;
    readonly resetToken: string;
    readonly resetUrl: string;
    readonly to: string;
  },
  deps: ResetDispatchDeps
): Promise<ResetDispatchedRecord> => {
  const locale = input.locale ?? LOCALE_DEFAULT;
  const variables: ResetEmailVariables = {
    locale,
    resetToken: input.resetToken,
    resetUrl: input.resetUrl,
  };
  const intent: ResetEmailIntent = {
    locale,
    subject: localizedSubject(locale),
    template: RESET_PASSWORD_EMAIL_TEMPLATE,
    to: input.to,
    variables,
  };
  // `send` never throws on an API error — destructure and check `error` first.
  const { data, error } = await deps.send(intent);
  if (error) {
    deps.audit("auth.reset_password_email_failed");
  } else if (data) {
    // Success — never log the payload or any provider secret.
    deps.audit("auth.reset_password_email_sent");
  }
  return {
    error,
    locale: intent.locale,
    template: intent.template,
    variables,
  };
};

// The worker wires the real Resend sender here at boot; the default is a safe
// no-op so packages/auth stays SDK-free and a missing wiring never throws.
let configuredSender: ResetEmailSender = () =>
  Promise.resolve({ data: { id: "pending" }, error: null });

export const configureResetEmailSender = (sender: ResetEmailSender): void => {
  configuredSender = sender;
};

export const resetResetEmailSender = (): void => {
  configuredSender = () =>
    Promise.resolve({ data: { id: "pending" }, error: null });
};

export const resetEmailSender = (): ResetEmailSender => configuredSender;
