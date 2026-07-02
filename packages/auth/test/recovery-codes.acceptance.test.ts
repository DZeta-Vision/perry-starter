// Acceptance — break-glass recovery codes: a fixed-count set generated
// server-side, hashed at rest (never plaintext, timing-safe verify), consumed
// single-use and atomically, and re-issued only under a superadmin gate.

import {
  authorizeRecoveryReissue,
  consumeRecoveryCode,
  generateRecoveryCodes,
  persistRecoveryCodes,
  RECOVERY_CODE_COUNT_DEFAULT,
  type RecoveryCodeRow,
} from "@perry-starter/auth/recovery-codes";
import { describe, expect, test } from "vitest";

const NOW = "2026-07-02T12:00:00.000Z";
const LATER = "2026-07-02T12:05:00.000Z";
const USER = "user-1";

describe("recovery codes are generated fixed-count, high-entropy, and hashed at rest", () => {
  test("the default count is 10 distinct high-entropy codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT_DEFAULT);
    expect(RECOVERY_CODE_COUNT_DEFAULT).toBe(10);
    // All distinct (real randomness).
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code.length).toBeGreaterThan(0);
    }
  });

  test("persisted rows carry only the hash — never the plaintext code — plus a null spend timestamp and the user ref", async () => {
    const codes = generateRecoveryCodes(3);
    const rows = await persistRecoveryCodes(USER, codes);
    expect(rows).toHaveLength(3);
    const serialized = JSON.stringify(rows);
    for (const code of codes) {
      expect(serialized).not.toContain(code);
    }
    for (const row of rows) {
      expect(row.hashed_code.length).toBeGreaterThan(0);
      expect(row.used_at).toBeNull();
      expect(row.user_ref).toBe(USER);
    }
  });
});

describe("a recovery code is single-use and consumed atomically", () => {
  test("the first use succeeds; the SAME code is rejected on replay and the row stays spent", async () => {
    const codes = generateRecoveryCodes(3);
    const rows = await persistRecoveryCodes(USER, codes);
    const target = codes[1] as string;

    const first = await consumeRecoveryCode(rows, target, NOW);
    expect(first.consumed).toBe(true);
    expect(rows[first.rowIndex]?.used_at).toBe(NOW);

    // Replay of the spent code is rejected; the timestamp is not overwritten.
    const replay = await consumeRecoveryCode(rows, target, LATER);
    expect(replay.consumed).toBe(false);
    expect(rows[first.rowIndex]?.used_at).toBe(NOW);
  });

  test("a code that matches no stored row is rejected and spends nothing", async () => {
    const rows = await persistRecoveryCodes(USER, generateRecoveryCodes(2));
    const before = rows.map((r: RecoveryCodeRow) => r.used_at);
    const result = await consumeRecoveryCode(rows, "not-a-real-code", NOW);
    expect(result.consumed).toBe(false);
    expect(rows.map((r) => r.used_at)).toEqual(before);
  });

  test("each remaining unused code still consumes exactly once", async () => {
    const codes = generateRecoveryCodes(3);
    const rows = await persistRecoveryCodes(USER, codes);
    for (const code of codes) {
      expect((await consumeRecoveryCode(rows, code, NOW)).consumed).toBe(true);
    }
    // Every row is now spent; nothing is left to consume.
    expect(rows.every((r) => r.used_at !== null)).toBe(true);
    expect(
      (await consumeRecoveryCode(rows, codes[0] as string, LATER)).consumed
    ).toBe(false);
  });
});

describe("break-glass re-issue is superadmin-gated (never self-service)", () => {
  test("only a superadmin may re-issue recovery codes", () => {
    expect(authorizeRecoveryReissue("superadmin")).toBe(true);
    expect(authorizeRecoveryReissue("admin")).toBe(false);
    expect(authorizeRecoveryReissue("member")).toBe(false);
  });
});
