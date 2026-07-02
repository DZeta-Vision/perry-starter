// Keyset read-path guard — the admin user list is an index-backed keyset walk,
// never an OFFSET/START deep-page.
//
// This is a build-time STRUCTURAL guard: it drives the SHIPPED keyset builder and
// asserts the emitted query orders + limits with the cursor as a WHERE bound and
// carries NO OFFSET/START, and that the read-path guard classifies it as a keyset
// read. The mutation twin (user-list-keyset.mutation.test.ts) feeds the SAME guard
// an OFFSET/START query and a missing-ORDER/LIMIT query and asserts each reddens,
// proving the guard is anti-vacuous. The real-`surreal` EXPLAIN plan-shape (the
// IndexScan-not-TableScan proof) lives in the acceptance suite.

import { expect, test } from "vitest";

import { buildUserListKeysetSql, isKeysetUserListRead } from "../user-admin";

const ORDER_RE = /ORDER\s+BY\s+created_at\s+DESC/i;
const LIMIT_RE = /\bLIMIT\b/i;
const OFFSET_START_RE = /\b(?:OFFSET|START)\b/i;

test("the shipped user-list keyset builder emits an ORDER BY + LIMIT read with no OFFSET/START", () => {
  const { query } = buildUserListKeysetSql({
    cursor: "2026-07-02T10:00:00.000Z",
    limit: 50,
    status: "active",
  });
  expect(isKeysetUserListRead(query)).toBe(true);
  expect(query).toMatch(ORDER_RE);
  expect(query).toMatch(LIMIT_RE);
  expect(query).not.toMatch(OFFSET_START_RE);
});

test("the cursor is a keyset WHERE bound, not a deep-page offset", () => {
  const { query, vars } = buildUserListKeysetSql({
    cursor: "2026-07-02T10:00:00.000Z",
    limit: 50,
  });
  expect(query).toContain("created_at < type::datetime($cursor)");
  expect(vars.cursor).toBe("2026-07-02T10:00:00.000Z");
});

test("the list projection never selects the credential hash", () => {
  const { query } = buildUserListKeysetSql({ limit: 50 });
  expect(query).not.toContain("pass");
});

test("the guard is non-vacuous: a fresh valid keyset query passes", () => {
  const { query } = buildUserListKeysetSql({ limit: 10 });
  expect(isKeysetUserListRead(query)).toBe(true);
});
