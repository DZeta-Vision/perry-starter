// Behavior tests for the forwarder-backed admin sink factories (d93) — pure over an
// injected fake forwarder, no live DB. They prove each sink forwards the expected
// SurrealQL (keyset SELECT / scoped write) and maps rows to validated shapes, and
// that the audit write refuses a below-admin session writer (fail-closed) before any
// forward.

import type { SqlResult } from "@perry-starter/data/surreal-http";
import { expect, test, vi } from "vitest";

import { makeAdminSinks } from "./admin-sinks";

const ok = (result: unknown): SqlResult[] => [{ result, status: "OK" }];

const auditRow = () => ({
  action: "auth.sign_in",
  actor: "user:01J0XQT8Z9N3H6K2M5P7R9T1V3",
  actor_email: "person@example.com",
  actor_role: "member",
  id: "audit_log:01ARZ3NDEKTSV4RRFFQ69G5FAV",
  ip: "127.0.0.1",
  metadata: {},
  target_id: "session:1",
  target_type: "session",
  timestamp: "2026-07-02T08:26:30.607Z",
  user_agent: "UA",
});

const OFFSET_RE = /\b(?:OFFSET|START)\b/;

test("readAuditEntries forwards the keyset SELECT and maps rows to validated entries", async () => {
  const forward = vi.fn(() => Promise.resolve(ok([auditRow()])));
  const sinks = makeAdminSinks(forward);
  const entries = await sinks.readAuditEntries({ limit: 50 });
  expect(entries).toHaveLength(1);
  expect(entries[0]?.id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  const query = forward.mock.calls[0]?.[0] as string;
  expect(query).toContain("ORDER BY id DESC");
  expect(query).not.toMatch(OFFSET_RE);
});

test("listUsers forwards the keyset SELECT with bound vars and maps rows (no OFFSET)", async () => {
  const forward = vi.fn(() =>
    Promise.resolve(
      ok([
        {
          created_at: "2026-07-02T10:00:00.000Z",
          email: "u@example.com",
          id: "user:u1",
          role: "member",
          status: "active",
        },
      ])
    )
  );
  const sinks = makeAdminSinks(forward);
  const users = await sinks.listUsers({ limit: 10, status: "active" });
  expect(users[0]?.id).toBe("u1");
  const [query, vars] = forward.mock.calls[0] as [
    string,
    Record<string, string>,
  ];
  expect(query).toContain("ORDER BY created_at DESC");
  expect(query).not.toMatch(OFFSET_RE);
  expect(vars).toMatchObject({ status: "active" });
});

test("setUserRole / setUserStatus / revokeUserSessions forward the scoped writes with bound ids", async () => {
  const forward = vi.fn(() => Promise.resolve(ok([])));
  const sinks = makeAdminSinks(forward);
  await sinks.setUserRole({ role: "admin", userId: "u1" });
  await sinks.setUserStatus({ status: "deactivated", userId: "u1" });
  await sinks.revokeUserSessions({
    surfaces: ["cloud", "local"],
    userId: "u1",
  });
  const queries = forward.mock.calls.map((call) => call[0] as string);
  expect(queries[0]).toContain("SET role = 'admin'");
  expect(queries[1]).toContain("SET status = 'deactivated'");
  expect(queries[2]).toContain("DELETE session WHERE userId = $uid");
});

test("writeAudit refuses a below-admin session writer (fail-closed, no forward) and appends for system", async () => {
  const forward = vi.fn(() => Promise.resolve(ok([])));
  const sinks = makeAdminSinks(forward);
  const input = {
    action: "admin.role_change" as const,
    actor: "user:01J0XQT8Z9N3H6K2M5P7R9T1V3",
    actor_email: "admin@example.com",
    actor_role: "admin",
    ip: "127.0.0.1",
    metadata: {},
    target_id: "user:t",
    target_type: "user",
    user_agent: "UA",
  };
  await expect(
    sinks.writeAudit(input, { kind: "session", role: "member" })
  ).rejects.toThrow();
  expect(forward).not.toHaveBeenCalled();
  await sinks.writeAudit(input, { kind: "system" });
  expect(forward).toHaveBeenCalledTimes(1);
  expect((forward.mock.calls[0]?.[0] as string).startsWith("CREATE ")).toBe(
    true
  );
});
