// Idempotent superadmin seeding — bootstrap exactly one privileged account safely.
//
// Cloud/worker tier, run in the deploy/seed step. The orchestration here is
// adopter-built wiring (better-auth ships no "seed one superadmin" flow); its
// primitives are injected as seams so the exact same decision runs in the deploy
// step and under test:
//
//   - `countSuperadmins` reads how many superadmins already exist.
//   - `createSuperadmin` creates the account. Production binds it to the auth
//     library's owned create-user path (scrypt hash + breach screen on the
//     credential-setting endpoint) so the temp password is HASHED before storage
//     and never persisted in plaintext — the hash is never rolled here.
//   - `logTempCredential` surfaces the one-time temp password EXACTLY ONCE (to the
//     operator log), never persisted, never returned in the result, never logged
//     twice.
//
// Idempotency: seed creates iff no superadmin exists. A re-run against a system
// that already has a superadmin is a no-op that mints no second superadmin and
// creates no new temp credential; the account is recoverable via the standard
// (superadmin-gated, audited) reset/recovery path, not a second seed.

import { randomToken } from "./secret-hash";

// ≥256-bit entropy: 32 random bytes. The base64url encoding is 43 chars — inside
// the NIST 800-63B 12–128 length window.
const TEMP_PASSWORD_ENTROPY_BYTES = 32;
export const TEMP_PASSWORD_ENTROPY_BITS = TEMP_PASSWORD_ENTROPY_BYTES * 8;

// The GLOBAL app-authz tier the seeded account is stamped with.
export const SUPERADMIN_ROLE = "superadmin";

// Audit actions (closed `<domain>.<verb>` vocabulary, domain `admin`).
export const SUPERADMIN_SEEDED_AUDIT = "admin.superadmin_seeded";
export const SUPERADMIN_SEED_SKIPPED_AUDIT = "admin.superadmin_seed_skipped";

// A high-entropy one-time temp password. Sole entropy source is
// `crypto.getRandomValues` (never `Math.random`); never reused, never rolled.
export const generateTempPassword = (): string =>
  randomToken(TEMP_PASSWORD_ENTROPY_BYTES);

export interface SeededSuperadminInput {
  readonly email: string;
  readonly emailVerified: true;
  readonly password: string;
  readonly requirePasswordChange: true;
  readonly role: typeof SUPERADMIN_ROLE;
}

export interface SuperadminSeedSeams {
  readonly countSuperadmins: () => Promise<number>;
  readonly createSuperadmin: (
    input: SeededSuperadminInput
  ) => Promise<{ readonly userId: string }>;
  // Surface the temp credential to the operator log EXACTLY ONCE.
  readonly logTempCredential: (line: {
    readonly email: string;
    readonly password: string;
  }) => void;
  readonly recordAudit?: (action: string) => void;
}

export interface SuperadminSeedResult {
  readonly created: boolean;
  readonly reason: "seeded" | "already-present";
  readonly userId?: string;
}

// Run the seed. Create iff none; the temp password is generated here, handed to
// `createSuperadmin` (which hashes it before storage), and logged exactly once.
// The plaintext is NEVER placed in the returned result.
export const seedSuperadmin = async (
  email: string,
  seams: SuperadminSeedSeams
): Promise<SuperadminSeedResult> => {
  const existing = await seams.countSuperadmins();
  if (existing > 0) {
    // Re-run no-op: no second superadmin, no new temp credential. Recovery is the
    // standard superadmin-gated/audited path, not a second seed.
    seams.recordAudit?.(SUPERADMIN_SEED_SKIPPED_AUDIT);
    return { created: false, reason: "already-present" };
  }
  const password = generateTempPassword();
  const { userId } = await seams.createSuperadmin({
    email,
    emailVerified: true,
    password,
    requirePasswordChange: true,
    role: SUPERADMIN_ROLE,
  });
  // Logged EXACTLY ONCE — after the account exists, so a failed create never
  // leaks a credential for an account that was not made.
  seams.logTempCredential({ email, password });
  seams.recordAudit?.(SUPERADMIN_SEEDED_AUDIT);
  return { created: true, reason: "seeded", userId };
};
