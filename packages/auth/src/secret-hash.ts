// Secret-at-rest hashing + high-entropy encoding — the no-plaintext floor for the
// break-glass recovery codes (and any other secret this tier must persist).
//
// Cloud/worker tier. Argon2id is NOT a `crypto.subtle` algorithm (it is a separate
// native module reserved for the daemon), so the KDF here is PBKDF2-SHA-256 —
// `crypto.subtle`'s KDF arms are PBKDF2 and HKDF only — with a per-secret random
// salt and a high iteration count. A stored hash is the self-describing string
// `pbkdf2$<iterations>$<saltB64url>$<hashB64url>`; verification re-derives with the
// stored parameters and compares the derived bits in CONSTANT TIME. The plaintext
// secret is never persisted and never returned by any of these helpers.

const PBKDF2_ITERATIONS = 210_000;
const PBKDF2_HASH = "SHA-256";
const DERIVED_BITS = 256;
const SALT_BYTES = 16;
const STORED_PREFIX = "pbkdf2";

// Top-level regex literals (Biome: never build a regex inside a function).
const B64_PLUS_RE = /\+/g;
const B64_SLASH_RE = /\//g;
const B64_PAD_RE = /=+$/;
const B64URL_DASH_RE = /-/g;
const B64URL_UNDERSCORE_RE = /_/g;

// URL-safe base64 (no padding) over raw bytes — portable across the worker and the
// node test runner (no Buffer dependency assumption).
export const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(B64_PLUS_RE, "-")
    .replace(B64_SLASH_RE, "_")
    .replace(B64_PAD_RE, "");
};

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value
    .replace(B64URL_DASH_RE, "+")
    .replace(B64URL_UNDERSCORE_RE, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

// N cryptographically-random bytes as a URL-safe string. The sole entropy source
// is `crypto.getRandomValues` (never `Math.random`).
export const randomToken = (byteLength: number): string =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));

const deriveBits = async (
  secret: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> => {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: PBKDF2_HASH },
    baseKey,
    DERIVED_BITS
  );
  return new Uint8Array(bits);
};

// Hash a secret for storage. Returns the self-describing PHC-like string; the
// plaintext is never embedded and never returned.
export const hashSecret = async (secret: string): Promise<string> => {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await deriveBits(secret, salt, PBKDF2_ITERATIONS);
  return `${STORED_PREFIX}$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
};

// Constant-time byte comparison — no early return on the first mismatch, so a
// verify leaks no timing signal about how much of the hash matched. Differences
// are accumulated as a sum of absolute byte deltas (branchless, no bitwise ops);
// the result is zero iff every byte matched.
const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  }
  return diff === 0;
};

// Verify a presented secret against a stored hash in constant time. A malformed
// stored string returns false rather than throwing (fail-closed).
export const verifySecret = async (
  secret: string,
  stored: string
): Promise<boolean> => {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== STORED_PREFIX) {
    return false;
  }
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    return false;
  }
  const salt = fromBase64Url(parts[2] ?? "");
  const expected = fromBase64Url(parts[3] ?? "");
  const derived = await deriveBits(secret, salt, iterations);
  return timingSafeEqual(derived, expected);
};
