// Bilingual (FR/EN) Resend verification-email dispatch wrapper.
//
// Worker-tier dispatch logic that is deliberately SDK-FREE: it NEVER imports the
// Resend SDK (that import is worker-only). The actual `send` is injected — the
// worker wires the real `resend.emails.send`; tests inject a capture double. The
// Resend result is a discriminated union that NEVER throws on an API error, so we
// destructure `{ data, error }` and handle `error` FIRST (audit a failed send),
// never leaking provider/stack detail and never throwing out of the send path.
//
// The template is the `perry-verification` react-email component (AD-21: camelCase
// variables, Lingui-keyed FR/EN strings). The FR/EN catalog is activated off the
// account `locale` at render time — keyed off the prop, no request context.

import { LOCALE_DEFAULT } from "@perry-starter/db/shapes/identity";

// The result shape of `resend.emails.send` (the subset we read). `send` never
// throws — on API error it returns `{ data: null, error }`.
export interface SendResult {
  readonly data: { readonly id: string } | null;
  readonly error: { readonly name: string } | null;
}

export interface VerificationEmailVariables {
  readonly locale: string;
  readonly verifyToken: string;
  readonly verifyUrl: string;
}

export interface VerificationEmailIntent {
  readonly locale: string;
  readonly subject: string;
  readonly template: "perry-verification";
  readonly to: string;
  readonly variables: VerificationEmailVariables;
}

export type VerificationEmailSender = (
  intent: VerificationEmailIntent
) => Promise<SendResult>;

export interface DispatchDeps {
  readonly audit: (action: string) => void;
  readonly send: VerificationEmailSender;
}

export interface DispatchedRecord {
  readonly error: SendResult["error"];
  readonly locale: string;
  readonly template: string;
  readonly variables: VerificationEmailVariables;
}

// Bilingual subject keyed off the account locale — proves the locale var is
// actually consumed (an FR account never receives EN copy). The keys resolve to
// distinct FR/EN strings under the active Lingui catalog at render time.
const localizedSubject = (locale: string): string =>
  locale === "fr"
    ? "email.verification.subject.fr"
    : "email.verification.subject.en";

// Dispatch the verification email. The send error is destructured and handled
// first; the path never throws. Returns what was dispatched (for audit/log), with
// the error surfaced as data — never re-thrown.
export const dispatchVerificationEmail = async (
  input: {
    readonly locale?: string;
    readonly to: string;
    readonly verifyToken: string;
    readonly verifyUrl: string;
  },
  deps: DispatchDeps
): Promise<DispatchedRecord> => {
  const locale = input.locale ?? LOCALE_DEFAULT;
  const variables: VerificationEmailVariables = {
    locale,
    verifyToken: input.verifyToken,
    verifyUrl: input.verifyUrl,
  };
  const intent: VerificationEmailIntent = {
    locale,
    subject: localizedSubject(locale),
    template: "perry-verification",
    to: input.to,
    variables,
  };
  // `send` never throws on an API error — destructure and check `error` first.
  const { data, error } = await deps.send(intent);
  if (error) {
    deps.audit("auth.verification_email_failed");
  } else if (data) {
    // Success — never log the payload or any provider secret (AD-21).
    deps.audit("auth.verification_email_sent");
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
let configuredSender: VerificationEmailSender = () =>
  Promise.resolve({ data: { id: "pending" }, error: null });

export const configureVerificationEmailSender = (
  sender: VerificationEmailSender
): void => {
  configuredSender = sender;
};

export const verificationEmailSender = (): VerificationEmailSender =>
  configuredSender;
