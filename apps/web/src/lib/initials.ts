// The locale-aware avatar-initials helper — a PURE, total function.
//
// Initials derive from the session's given_name/family_name, with a deterministic
// fallback chain so the avatar is NEVER blank or a crash: a single present name
// part yields its initial; with no name parts the first letter of the email is
// used; with nothing usable a defined sentinel is returned. The `locale` seam is
// honored for the ordering of the two-part case — the supported locales (fr/en)
// are both given-name-first, so it currently never reorders, but the parameter
// keeps the ordering decision explicit for the locales that land in Epic 7.

import type { Locale } from "./auth-strings";

// The defined last-resort sentinel — returned only when no name part and no email
// are available, so the avatar never renders empty.
export const FALLBACK_INITIAL = "?";

export interface InitialsInput {
  readonly email?: string | null;
  readonly family_name?: string | null;
  readonly given_name?: string | null;
  readonly locale?: Locale;
}

const firstGrapheme = (value: string): string =>
  // Spread to split on code points so a multibyte first letter is not cut.
  [...value.trim()][0] ?? "";

export const avatarInitials = ({
  given_name,
  family_name,
  email,
}: InitialsInput): string => {
  const given = firstGrapheme(given_name ?? "");
  const family = firstGrapheme(family_name ?? "");

  // Both parts present: given-then-family (fr and en alike).
  if (given && family) {
    return (given + family).toUpperCase();
  }
  // A single present part stands alone.
  if (given) {
    return given.toUpperCase();
  }
  if (family) {
    return family.toUpperCase();
  }
  // No name parts: first letter of the email.
  const emailInitial = firstGrapheme(email ?? "");
  if (emailInitial) {
    return emailInitial.toUpperCase();
  }
  // Nothing usable: the defined sentinel, never a blank avatar.
  return FALLBACK_INITIAL;
};
