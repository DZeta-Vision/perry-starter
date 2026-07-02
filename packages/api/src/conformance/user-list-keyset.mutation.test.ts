// Mutation twin for user-list-keyset.gate.test.ts.
//
// It feeds the REAL keyset read-path guard known-bad queries and asserts each
// reddens, proving the guard is anti-vacuous: an OFFSET/START deep-page and a
// query missing ORDER BY / LIMIT are NOT keyset reads. It also drives the good
// baseline to prove the guard stays green on the real builder output.

import { expect, test } from "vitest";

import { buildUserListKeysetSql, isKeysetUserListRead } from "../user-admin";

test("an OFFSET deep-paged read fails the keyset guard", () => {
  const bad =
    "SELECT id FROM user ORDER BY created_at DESC LIMIT 50 START 100;";
  expect(isKeysetUserListRead(bad)).toBe(false);
});

test("a START (OFFSET) deep-paged read fails the keyset guard", () => {
  const bad =
    "SELECT id FROM user ORDER BY created_at DESC LIMIT 50 OFFSET 200;";
  expect(isKeysetUserListRead(bad)).toBe(false);
});

test("a read missing ORDER BY fails the keyset guard", () => {
  const bad = "SELECT id FROM user WHERE status = 'active' LIMIT 50;";
  expect(isKeysetUserListRead(bad)).toBe(false);
});

test("a read missing LIMIT fails the keyset guard", () => {
  const bad = "SELECT id FROM user ORDER BY created_at DESC;";
  expect(isKeysetUserListRead(bad)).toBe(false);
});

test("the good baseline stays green — the real builder output is a keyset read", () => {
  const { query } = buildUserListKeysetSql({ limit: 50, status: "active" });
  expect(isKeysetUserListRead(query)).toBe(true);
});
