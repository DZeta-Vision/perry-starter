// Mutation twin for the erasure soft-delete gate — proves the "never a hard delete"
// checks are load-bearing.
//
// It feeds the SAME pure checkers the gate relies on (`isSoftDeleteSql` for the
// account write, `isRegistrationOnlySql` for the registry write) a HARD-delete
// statement and asserts each goes RED, with the real builder output as the green
// control. If either checker passed a hard delete, the gate's soft-delete assertion
// would be vacuous — these red cases prove it is not.

import { expect, test } from "vitest";

import {
  buildRegisterShredSubjectSql,
  isRegistrationOnlySql,
} from "../crypto-shred-registry";
import { buildErasureSoftDeleteSql } from "../erasure";
import { isSoftDeleteSql } from "../user-admin";

const SUBJECT = "user-erase-1";
const NOW_ISO = "2026-07-02T09:00:00.000Z";

test("a hard DELETE of the account is NOT accepted as a soft-delete (the checker reddens)", () => {
  // A hard delete masquerading as an erasure — the checker must reject it.
  expect(isSoftDeleteSql("DELETE type::record('user', $id);")).toBe(false);
  expect(
    isSoftDeleteSql("UPDATE user SET x = 1; DELETE user WHERE id = $id;")
  ).toBe(false);
  // Green control: the REAL erasure builder is a soft delete.
  expect(
    isSoftDeleteSql(buildErasureSoftDeleteSql(SUBJECT, NOW_ISO).query)
  ).toBe(true);
});

test("a registry write that hard-deletes is NOT accepted as registration-only (the checker reddens)", () => {
  expect(
    isRegistrationOnlySql(
      "UPSERT erasure_shred_subject SET key_class = 'crypto-shred'; DELETE erasure_shred_subject;"
    )
  ).toBe(false);
  // Green control: the REAL registry builder is additive-only.
  expect(
    isRegistrationOnlySql(
      buildRegisterShredSubjectSql(SUBJECT, "key-handle-abc").query
    )
  ).toBe(true);
});
