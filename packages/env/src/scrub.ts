// The NFR floor for observability: a pure, dependency-free secret scrubber.
//
// "Log event type + actor, never payload/secrets." Nothing in the stack
// auto-redacts a secret that lands in a log attribute or a Sentry envelope — a
// bearer token, a password, an api-key, a Set-Cookie header will otherwise flow
// verbatim to the sink. This scrubber is the ONE control shared by BOTH the edge
// Sentry redaction (`beforeSendLog` / `beforeSend` in apps/web) AND the daemon's
// hand-rolled envelope + structured-console emit — so no tier can leak a
// secret-bearing field the others block.
//
// It is a DENY-LIST over KEYS (not values): a field whose key names a secret is
// redacted to `[redacted]`; the traversal is recursive over plain objects and
// arrays so a nested `{ headers: { authorization } }` is caught, not just a
// top-level key. Pure, no imports — safe in the Perry daemon graph (no SDK/WASM).

export const REDACTED = "[redacted]";

// Case-insensitive substrings that mark a KEY as secret-bearing. A key is denied
// when its lowercased form CONTAINS any needle, so `Authorization`, `Set-Cookie`,
// `x-api-key`, `refreshToken`, `sessionToken`, `passwordHash`, `clientSecret` all
// match — while benign identifiers like `sessionId`, `actor`, `userId` do NOT
// (they carry none of these needles), so real audit context survives.
const DENIED_KEY_SUBSTRINGS = [
  "authorization",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "cookie",
  "apikey",
  "api_key",
  "api-key",
  "credential",
  "privatekey",
  "private_key",
  "private-key",
  "bearer",
] as const;

// Whether a field name denotes a secret-bearing value (case-insensitive).
export const isSecretKey = (key: string): boolean => {
  const lowered = key.toLowerCase();
  return DENIED_KEY_SUBSTRINGS.some((needle) => lowered.includes(needle));
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const scrubValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(scrubValue);
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = isSecretKey(key) ? REDACTED : scrubValue(nested);
    }
    return out;
  }
  return value;
};

// Return a structurally-identical copy with every secret-keyed field (at any
// depth) replaced by `[redacted]`. Non-object inputs pass through unchanged. The
// input is never mutated.
export const scrubSecrets = <T>(value: T): T => scrubValue(value) as T;

// A convenience predicate the notification/alert guards reuse: the value carries
// no secret-keyed field anywhere (scrubbing is a no-op). Used to assert a body is
// secret-free before it leaves the process.
export const isSecretFree = (value: unknown): boolean =>
  JSON.stringify(scrubSecrets(value)) === JSON.stringify(value);
