// Acceptance — the idempotent superadmin seed: exactly one superadmin, a
// ≥256-bit temp password logged EXACTLY ONCE and hashed before storage, the
// account stamped emailVerified + requirePasswordChange, and a re-run that mints
// no second superadmin.
//
// The seed's DB/create/log primitives are injected seams (the same shape the
// deploy step binds), so the orchestration decision is exercised deterministically.
// The `createSuperadmin` fake HASHES the temp password with the real
// `hashSecret`/`verifySecret`, standing in for the auth library's owned scrypt
// hash — proving "hashed before storage, never plaintext at rest" as a contract.

import { hashSecret, verifySecret } from "@perry-starter/auth/secret-hash";
import {
  generateTempPassword,
  SUPERADMIN_ROLE,
  seedSuperadmin,
  TEMP_PASSWORD_ENTROPY_BITS,
} from "@perry-starter/auth/superadmin-seed";
import { describe, expect, test } from "vitest";

const NIST_MIN = 12;
const NIST_MAX = 128;
const SEED_EMAIL = "superadmin@matrix.example.com";

interface StoredUser {
  readonly email: string;
  readonly emailVerified: boolean;
  // Only the HASH is stored — never the plaintext password.
  readonly password_hash: string;
  readonly requirePasswordChange: boolean;
  readonly role: string;
  readonly userId: string;
}

// A fake authority store: `createSuperadmin` hashes the temp password (never
// stores plaintext) and records the superadmin count so `countSuperadmins`
// reflects prior creates — the same contract the real create-user path honors.
const createFakeAuthority = () => {
  const users: StoredUser[] = [];
  const log: { email: string; password: string }[] = [];
  const audits: string[] = [];
  let counter = 0;

  const seams = {
    countSuperadmins: () =>
      Promise.resolve(users.filter((u) => u.role === SUPERADMIN_ROLE).length),
    createSuperadmin: async (input: {
      email: string;
      password: string;
      role: typeof SUPERADMIN_ROLE;
      emailVerified: true;
      requirePasswordChange: true;
    }) => {
      counter += 1;
      const userId = `user-${counter}`;
      users.push({
        email: input.email,
        emailVerified: input.emailVerified,
        password_hash: await hashSecret(input.password),
        requirePasswordChange: input.requirePasswordChange,
        role: input.role,
        userId,
      });
      return { userId };
    },
    logTempCredential: (line: { email: string; password: string }) => {
      log.push(line);
    },
    recordAudit: (action: string) => {
      audits.push(action);
    },
  };

  return { audits, log, seams, users };
};

describe("the superadmin seed is idempotent — exactly one, and re-run mints none", () => {
  test("seeding an empty system creates exactly one superadmin, stamped verified + must-change-password", async () => {
    const authority = createFakeAuthority();
    const result = await seedSuperadmin(SEED_EMAIL, authority.seams);

    expect(result.created).toBe(true);
    expect(result.reason).toBe("seeded");
    const superadmins = authority.users.filter(
      (u) => u.role === SUPERADMIN_ROLE
    );
    expect(superadmins).toHaveLength(1);
    expect(superadmins[0]?.email).toBe(SEED_EMAIL);
    expect(superadmins[0]?.emailVerified).toBe(true);
    expect(superadmins[0]?.requirePasswordChange).toBe(true);
  });

  test("re-running the seed against a system that already has a superadmin creates no second superadmin", async () => {
    const authority = createFakeAuthority();
    await seedSuperadmin(SEED_EMAIL, authority.seams);
    const second = await seedSuperadmin(SEED_EMAIL, authority.seams);

    expect(second.created).toBe(false);
    expect(second.reason).toBe("already-present");
    expect(
      authority.users.filter((u) => u.role === SUPERADMIN_ROLE)
    ).toHaveLength(1);
    // No new temp credential is minted or logged on the no-op re-run.
    expect(authority.log).toHaveLength(1);
  });
});

describe("the temp password is high-entropy, logged exactly once, and hashed before storage", () => {
  test("a generated temp password carries ≥256-bit entropy and is NIST-length-valid", () => {
    expect(TEMP_PASSWORD_ENTROPY_BITS).toBeGreaterThanOrEqual(256);
    for (let i = 0; i < 5; i += 1) {
      const pw = generateTempPassword();
      expect(pw.length).toBeGreaterThanOrEqual(NIST_MIN);
      expect(pw.length).toBeLessThanOrEqual(NIST_MAX);
    }
    // Two draws are distinct (real randomness, never a fixed literal).
    expect(generateTempPassword()).not.toBe(generateTempPassword());
  });

  test("the temp password is logged EXACTLY ONCE and never persisted or returned in plaintext", async () => {
    const authority = createFakeAuthority();
    const result = await seedSuperadmin(SEED_EMAIL, authority.seams);

    // Logged exactly once.
    expect(authority.log).toHaveLength(1);
    const logged = authority.log[0]?.password ?? "";
    expect(logged.length).toBeGreaterThan(0);

    // The stored record carries ONLY the hash — never the plaintext.
    const stored = authority.users[0];
    expect(stored?.password_hash).not.toBe(logged);
    expect(JSON.stringify(stored)).not.toContain(logged);
    // …and the hash verifies against the one-time plaintext (proving it hashed it).
    expect(await verifySecret(logged, stored?.password_hash ?? "")).toBe(true);

    // The result never carries the plaintext password.
    expect(JSON.stringify(result)).not.toContain(logged);
  });

  test("the seed emits an audit event on create and on the skipped re-run", async () => {
    const authority = createFakeAuthority();
    await seedSuperadmin(SEED_EMAIL, authority.seams);
    await seedSuperadmin(SEED_EMAIL, authority.seams);
    expect(authority.audits).toContain("admin.superadmin_seeded");
    expect(authority.audits).toContain("admin.superadmin_seed_skipped");
  });
});
