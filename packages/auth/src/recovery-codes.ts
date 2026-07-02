// Break-glass recovery codes — generated once, hashed at rest, single-use.
//
// Cloud/worker tier. On TOTP enrolment a fixed-count set of high-entropy codes is
// generated SERVER-SIDE, shown to the user EXACTLY ONCE (behind an explicit "I've
// saved these" gate on the client, copyable/downloadable), then persisted only as
// hashes (`./secret-hash`, PBKDF2 + per-code salt, constant-time verify). The
// plaintext codes are never persisted, never logged, and never returned after the
// one-time display. Consuming a code is single-use and atomic: the FIRST matching
// unused row is marked spent; a replay of a spent code, or a code that matches no
// row, is rejected. Break-glass re-issue is superadmin-gated, rate-limited, and
// audited — never a self-service email/SMS bypass.

import { hashSecret, randomToken, verifySecret } from "./secret-hash";

// The recovery-code count is a defaulted tunable (no exact count is pinned in the
// artifacts) — default 10; a later artifact may override.
export const RECOVERY_CODE_COUNT_DEFAULT = 10;
// Per-code entropy: 10 random bytes ≈ 80 bits, well above any brute-force floor
// for a single-use secret behind rate limiting.
const RECOVERY_CODE_ENTROPY_BYTES = 10;

// The persisted recovery-code row shape (snake_case fields): the code hash, the
// spend timestamp (null until consumed), and the owning user reference.
export interface RecoveryCodeRow {
  hashed_code: string;
  used_at: string | null;
  user_ref: string;
}

// Generate a fresh set of plaintext recovery codes (for the ONE-TIME display).
// These are never persisted in this form.
export const generateRecoveryCodes = (
  count: number = RECOVERY_CODE_COUNT_DEFAULT
): string[] =>
  Array.from({ length: count }, () => randomToken(RECOVERY_CODE_ENTROPY_BYTES));

// Persist a set of codes: each is hashed with its own salt. The returned rows
// carry only hashes — never the plaintext.
export const persistRecoveryCodes = async (
  userRef: string,
  codes: readonly string[]
): Promise<RecoveryCodeRow[]> => {
  const rows: RecoveryCodeRow[] = [];
  for (const code of codes) {
    rows.push({
      hashed_code: await hashSecret(code),
      used_at: null,
      user_ref: userRef,
    });
  }
  return rows;
};

export interface RecoveryConsumeResult {
  readonly consumed: boolean;
  // The index of the row that was spent (for the caller's atomic DB update), or
  // -1 when no unused row matched.
  readonly rowIndex: number;
}

// Consume a presented recovery code single-use and atomically. Scans the user's
// rows for the FIRST unused row whose hash matches (constant-time verify); on a
// match it stamps `used_at` in place and reports the row index so the caller can
// persist the same atomic spend. An already-used code (its row carries `used_at`)
// or a code matching no row is rejected — never re-spendable.
export const consumeRecoveryCode = async (
  rows: RecoveryCodeRow[],
  presented: string,
  nowIso: string
): Promise<RecoveryConsumeResult> => {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || row.used_at !== null) {
      continue;
    }
    if (await verifySecret(presented, row.hashed_code)) {
      row.used_at = nowIso;
      return { consumed: true, rowIndex: index };
    }
  }
  return { consumed: false, rowIndex: -1 };
};

// The break-glass re-issue authority: re-issuing recovery codes is superadmin-only
// (never self-service). Rate-limiting + audit are enforced by the caller through
// its seams; this is the role gate the API leg mirrors at the DB layer.
export const authorizeRecoveryReissue = (requesterRole: string): boolean =>
  requesterRole === "superadmin";
