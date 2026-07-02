// Reset-token purge scoping — the seam that keeps the prior-reset-token
// invalidation from clobbering two-factor / recovery enrolment state.
//
// The prior-reset-token invalidation (see ./index `invalidatePriorResetTokens`)
// deletes verification rows so a freshly issued reset token invalidates any
// earlier one. Historically it deleted EVERY verification row for the reset
// target (keyed on the row's `value`, which the reset flow sets to the bare
// user id). That was correct only while password-reset was the SOLE user-keyed
// writer of the verification store.
//
// Mandatory two-factor enrolment adds a second user-keyed verification writer:
// the pending-enrolment marker (the state that says "this admin/superadmin still
// owes a TOTP enrolment"). If that marker were keyed by the bare user id too, the
// reset purge would over-delete it and silently drop the enrolment obligation —
// or, symmetrically, clobber the recovery/TOTP artifacts.
//
// The store persists the verification identifier HASHED (better-auth
// `storeIdentifier: "hashed"`), and the create hook observes the identifier in
// its already-hashed form, so the purge CANNOT scope by a literal
// `reset-password:` identifier prefix. The equivalent scoping is realized on the
// `value` axis instead: reset rows keep the bare user id as their value, while the
// two-factor enrolment marker is written under this distinct namespace. The purge
// then (a) only fires for a reset-scope creation and (b) deletes only rows under
// the bare-user-id value — so a two-factor / recovery enrolment row is never in
// the delete set. The behavioral guarantee ("a reset-token sweep leaves the
// two-factor / recovery rows intact") is what the survival test proves.

// The namespace the two-factor enrolment marker's `value` carries, so the
// reset-scope purge (keyed on the bare user id) can never reach it.
export const TWO_FACTOR_VERIFICATION_PREFIX = "two-factor:";

// The verification-store `value` a two-factor enrolment marker is keyed by — the
// user id under the two-factor namespace, distinct from the bare-user-id value a
// reset token uses.
export const twoFactorVerificationScope = (userId: string): string =>
  `${TWO_FACTOR_VERIFICATION_PREFIX}${userId}`;

// Whether a verification row's `value` belongs to the two-factor namespace (an
// enrolment marker), as opposed to a bare reset-target user id.
export const isTwoFactorScopeValue = (value: string): boolean =>
  value.startsWith(TWO_FACTOR_VERIFICATION_PREFIX);

// Whether a verification `value` is a reset-scope value — a non-empty value that
// is NOT a two-factor enrolment marker. The prior-reset-token purge fires ONLY
// for a reset-scope creation and deletes ONLY reset-scope rows, so a two-factor /
// recovery enrolment row (namespaced value) is never purged.
export const isResetScopeValue = (value: string): boolean =>
  value.length > 0 && !isTwoFactorScopeValue(value);
