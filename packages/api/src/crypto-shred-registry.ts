// The per-subject crypto-shred key registry — the FOURTH independent key class.
//
// This module owns the compliance capability's key class: the per-subject key that,
// when destroyed, renders that subject's at-rest ciphertext unrecoverable (the
// irreversible leg of GDPR erasure) WITHOUT touching the immutable audit log. It is
// a DISTINCT key class: each subject's shred key is generated INDEPENDENTLY from the
// runtime CSPRNG (`crypto.getRandomValues`) — never derived from, and never sharing
// material or a derivation input with, the token-at-rest envelope key (class 3), the
// ES256 JWKS (class 1), the release-signing key (class 2), or the better-auth
// secret. There is no shared master; two generations yield unrelated material. The
// structural independence gate proves this module reaches for its own CSPRNG draw
// and references no other class's key/secret/derivation.
//
// MECHANISM DEFERRED (design-only): this module ships the REGISTRY surface and the
// erasure DIRECTION — it registers a subject and generates the independent key
// handle — but it deliberately exposes NO operation that performs the actual
// cryptographic destruction. The concrete shred mechanism is deferred; nothing here
// claims real crypto-shred, and no test asserts destruction. `shredded_at` on the
// registry row stays null (this module never sets it).

// The sealed registry table (PERMISSIONS NONE in the .surql schema). A single row
// per subject; registration runs through the privileged system forwarder.
export const SHRED_SUBJECT_TABLE = "erasure_shred_subject";

// The class-4 marker persisted on every registry row — pinned so a row can never
// mis-tag which key class its handle belongs to.
export const SHRED_KEY_CLASS = "crypto-shred" as const;

// The shred-key size (256-bit key material), independently generated per subject.
const SHRED_KEY_BYTES = 32;

// An explicit, machine-readable marker that the concrete crypto-shred MECHANISM is
// deferred (design-only). The gate asserts this so the surface can never silently
// present itself as performing real cryptographic destruction.
export const CRYPTO_SHRED_MECHANISM = "deferred" as const;

// A record-id key charset conservative enough to bind into a type::record target
// (better-auth ids are alphanumeric + `-`/`_`), mirroring the user-admin builders.
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

// Generate a subject's crypto-shred key INDEPENDENTLY — a fresh CSPRNG draw with NO
// derivation input, so it shares no material or master with any other key class.
// Takes no argument: the key is not derived from the subject id, a passphrase, or a
// shared secret — two calls yield unrelated key material.
export const generateShredKey = (): string =>
  bytesToBase64(crypto.getRandomValues(new Uint8Array(SHRED_KEY_BYTES)));

export interface RegisterShredSubjectSql {
  readonly query: string;
  readonly vars: Record<string, string>;
}

// Build the registry UPSERT for a subject: it record-keys on the subject id so a
// re-request converges on the ONE row (never a second registration), stamps the
// class-4 marker + the independently-generated key handle, and never issues a
// DELETE. The subject id + key handle travel as bound $vars — never spliced into the
// statement body. `registered_at` is left to its READONLY default; `shredded_at`
// stays null (the shred mechanism is deferred).
export const buildRegisterShredSubjectSql = (
  subjectId: string,
  keyHandle: string
): RegisterShredSubjectSql => {
  if (!SAFE_ID_RE.test(subjectId)) {
    throw new Error("subject id must be a safe record-id key");
  }
  return {
    query: `UPSERT type::record('${SHRED_SUBJECT_TABLE}', $subject) SET subject_ref = type::record('user', $subject), key_class = '${SHRED_KEY_CLASS}', key_handle = $keyHandle RETURN AFTER;`,
    vars: { subject: subjectId, keyHandle },
  };
};

// A guard proving the registration is additive (a registry UPSERT, never a hard
// delete). The registry is the recoverable soft-surface; the irreversible shred is
// the deferred mechanism, so a builder that ever emitted a DELETE/REMOVE here would
// fail this (the mutation twin proves it can fail).
const HARD_DELETE_RE = /\b(?:DELETE|REMOVE)\b/i;
const REGISTER_UPSERT_RE = /\bUPSERT\b[\s\S]*\bkey_class\b/i;
export const isRegistrationOnlySql = (query: string): boolean =>
  REGISTER_UPSERT_RE.test(query) && !HARD_DELETE_RE.test(query);
