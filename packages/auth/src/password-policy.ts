// NIST 800-63B password policy + HIBP k-anonymity breach screening.
//
// NIST 800-63B: length-only (12–128), NO composition or rotation rules. The
// length bounds here are the SINGLE source the better-auth instance reads for
// `emailAndPassword.minPasswordLength` / `maxPasswordLength`, so config and policy
// cannot drift. Breach screening is the `haveIBeenPwned()` k-anonymity check (the
// SHA-1 first-5-hex prefix is sent to the range API; only the suffix list comes
// back). Per D7 the screen is defense-in-depth atop the NIST policy — on a range-
// API outage it FAILS OPEN (accepts the NIST-valid password) so a third-party
// outage never bricks the only-unblocked action; the caller records an audit event.
//
// This is cloud/worker-tier (the HIBP egress is the authority's, never the daemon).

export const NIST_MIN_PASSWORD_LENGTH = 12;
export const NIST_MAX_PASSWORD_LENGTH = 128;

// The HIBP range API host (egress-allowlisted on the cloud authority, AD-29).
const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range";

// A minimal fetch shape so the range call is injectable for tests and so this
// module never couples to the global `fetch` type surface.
export interface RangeResponse {
  readonly ok: boolean;
  text: () => Promise<string>;
}
export type RangeFetch = (
  url: string,
  init?: { readonly headers?: Readonly<Record<string, string>> }
) => Promise<RangeResponse>;

export interface HibpScreenResult {
  // Whether the password appeared in the breach corpus (reachable + matched).
  readonly breached: boolean;
  // Whether the range API was unreachable and the screen fell OPEN (D7).
  readonly failedOpen: boolean;
}

export const isNistLengthValid = (password: string): boolean =>
  password.length >= NIST_MIN_PASSWORD_LENGTH &&
  password.length <= NIST_MAX_PASSWORD_LENGTH;

// Uppercase hex SHA-1 of the input (the HIBP k-anonymity hash form).
export const sha1HexUpper = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(input)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
};

// k-anonymity breach screen. Sends only the 5-hex prefix; matches the local suffix
// against the returned list. On ANY transport/parse failure it returns
// `failedOpen` (D7 fail-OPEN) rather than throwing — the caller audits the fallback.
export const screenPasswordAgainstHibp = async (
  password: string,
  fetchRange: RangeFetch
): Promise<HibpScreenResult> => {
  try {
    const hash = await sha1HexUpper(password);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const response = await fetchRange(`${HIBP_RANGE_URL}/${prefix}`, {
      headers: { "Add-Padding": "true" },
    });
    if (!response.ok) {
      return { breached: false, failedOpen: true };
    }
    const body = await response.text();
    const breached = body.split("\n").some((line) => {
      const [lineSuffix, count] = line.trim().split(":");
      return lineSuffix?.toUpperCase() === suffix && Number(count ?? "0") > 0;
    });
    return { breached, failedOpen: false };
  } catch {
    // Range API unreachable — fail OPEN (accept the NIST-valid password).
    return { breached: false, failedOpen: true };
  }
};
