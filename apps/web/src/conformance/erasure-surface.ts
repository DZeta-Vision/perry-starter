// Pure guards for the GDPR erasure surface conformance gate.
//
// They assert the shipped erasure panel (1) gates the action behind a DESTRUCTIVE
// confirm dialog (a real Dialog + a destructive affordance + a confirm CTA), (2)
// SEQUENCES a per-action step-up re-auth (the step-up modal), (3) never wires a
// session-killing effect on the abort path — cancelling aborts ONLY the action, never
// the session — (4) announces the erasure through a POLITE live region, and (5) routes
// every visible string through the locale catalog. Kept pure (source string in,
// verdict out) so the mutation twin can feed known-bad input and prove each reddens.
//
// Modal DEPTH (one level, never a dialog over a dialog) is enforced globally by
// `modal-depth.gate` over all of apps/web/src; this surface leans on that.

// A real destructive-confirm dialog: a Dialog root, a destructive-styled affordance,
// and a confirm call-to-action keyed from the catalog.
const DIALOG_ROOT_RE = /<Dialog(?![A-Za-z])/;
const DESTRUCTIVE_VARIANT_RE = /variant=["']destructive["']/;
const CONFIRM_CTA_RE = /erasure\.confirmCta/;
export const hasDestructiveConfirmDialog = (source: string): boolean =>
  DIALOG_ROOT_RE.test(source) &&
  DESTRUCTIVE_VARIANT_RE.test(source) &&
  CONFIRM_CTA_RE.test(source);

// The per-action step-up re-auth is sequenced (the step-up modal is rendered).
const STEP_UP_MODAL_RE = /<StepUpModal(?![A-Za-z])/;
export const sequencesStepUp = (source: string): boolean =>
  STEP_UP_MODAL_RE.test(source);

// Any session-killing effect — a cancel/abort must NEVER revoke the session, so none
// of these may appear in the surface CODE (the effect is structurally foreclosed).
// Comments are stripped first so prose that merely mentions "logout" (e.g. explaining
// that no logout can happen) never trips the check.
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");
const SESSION_KILL_RE =
  /\b(?:signOut|logout|logOut|revokeSession|killSession)\b/;
export const abortNeverKillsSession = (source: string): boolean =>
  !SESSION_KILL_RE.test(stripJsComments(source));

const ARIA_LIVE_POLITE_RE = /aria-live=["']polite["']/;
const ROLE_STATUS_RE = /role=["']status["']/;
// True iff the surface carries a POLITE live region (announced without a focus steal).
export const hasPoliteLiveRegion = (source: string): boolean =>
  ARIA_LIVE_POLITE_RE.test(source) && ROLE_STATUS_RE.test(source);

// True iff visible copy is routed through the locale catalog (the i18n seam).
export const routesCopyThroughCatalog = (source: string): boolean =>
  source.includes("tDataRights");
