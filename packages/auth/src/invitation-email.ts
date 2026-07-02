// Bilingual (FR/EN) invitation-email dispatch wrapper — the worker/authority-only
// seam that carries the one-time invitation token to the invitee.
//
// Worker-tier dispatch logic that is deliberately SDK-FREE: it NEVER imports the
// Resend SDK (that import is worker-only, and the tier-boundary build guard fails
// the daemon bundle on it). The actual `send` is injected — the worker wires the
// real `resend.emails.send`; tests inject a capture double. The Resend result is a
// discriminated union that NEVER throws on an API error, so we destructure
// `{ data, error }` and handle `error` FIRST, never leaking provider/stack detail
// and never throwing out of the send path. The dispatch is out-of-band so it never
// perturbs the byte-identical neutral invitation-surface response or its timing.
//
// The invitation link (carrying the single-use token) is the ONLY delivery of the
// plaintext token — only its digest is persisted — so the token reaches the invitee
// exactly once, through this seam, and never leaves the cloud tier by any other
// path.

import { LOCALE_DEFAULT } from "@perry-starter/db/shapes/identity";
import type { SendResult } from "./verification-email";

// The react-email template id keyed off the invitee locale.
export const INVITATION_EMAIL_TEMPLATE = "perry-invitation";

export interface InvitationEmailVariables {
  readonly acceptUrl: string;
  readonly invitationToken: string;
  readonly locale: string;
}

export interface InvitationEmailIntent {
  readonly locale: string;
  readonly subject: string;
  readonly template: typeof INVITATION_EMAIL_TEMPLATE;
  readonly to: string;
  readonly variables: InvitationEmailVariables;
}

export type InvitationEmailSender = (
  intent: InvitationEmailIntent
) => Promise<SendResult>;

export interface InvitationDispatchDeps {
  readonly audit: (action: string) => void;
  readonly send: InvitationEmailSender;
}

export interface InvitationDispatchedRecord {
  readonly error: SendResult["error"];
  readonly locale: string;
  readonly template: string;
  readonly variables: InvitationEmailVariables;
}

// Bilingual subject keyed off the invitee locale — proves the locale var is
// actually consumed (an FR invitee never receives EN copy).
const localizedSubject = (locale: string): string =>
  locale === "fr"
    ? "email.invitation.subject.fr"
    : "email.invitation.subject.en";

// Dispatch the invitation email. The send error is destructured and handled first;
// the path never throws. Returns what was dispatched (for audit/log), with the
// error surfaced as data — never re-thrown, never logging the token payload.
export const dispatchInvitationEmail = async (
  input: {
    readonly acceptUrl: string;
    readonly invitationToken: string;
    readonly locale?: string;
    readonly to: string;
  },
  deps: InvitationDispatchDeps
): Promise<InvitationDispatchedRecord> => {
  const locale = input.locale ?? LOCALE_DEFAULT;
  const variables: InvitationEmailVariables = {
    acceptUrl: input.acceptUrl,
    invitationToken: input.invitationToken,
    locale,
  };
  const intent: InvitationEmailIntent = {
    locale,
    subject: localizedSubject(locale),
    template: INVITATION_EMAIL_TEMPLATE,
    to: input.to,
    variables,
  };
  // `send` never throws on an API error — destructure and check `error` first.
  const { data, error } = await deps.send(intent);
  if (error) {
    deps.audit("admin.invitation_email_failed");
  } else if (data) {
    // Success — never log the payload or the token.
    deps.audit("admin.invitation_email_sent");
  }
  return {
    error,
    locale: intent.locale,
    template: intent.template,
    variables,
  };
};

// The worker wires the real Resend sender here at boot; the default is a safe no-op
// so packages/auth stays SDK-free and a missing wiring never throws.
let configuredSender: InvitationEmailSender = () =>
  Promise.resolve({ data: { id: "pending" }, error: null });

export const configureInvitationEmailSender = (
  sender: InvitationEmailSender
): void => {
  configuredSender = sender;
};

export const resetInvitationEmailSender = (): void => {
  configuredSender = () =>
    Promise.resolve({ data: { id: "pending" }, error: null });
};

export const invitationEmailSender = (): InvitationEmailSender =>
  configuredSender;
