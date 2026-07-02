// Unit proofs for the audit read/write surface (no live DB — the tRPC middleware
// decision, the write gate, the keyset query shape, and the row mapper).

import { describe, expect, test, vi } from "vitest";
import {
  AUDIT_READ_FORBIDDEN_MESSAGE,
  type AuditListInput,
  auditReadErrorShape,
  auditRouterProcedures,
  auditWriteInputSchema,
  authorizeAuditWrite,
  buildAuditKeysetSql,
  buildAuditWriteSql,
  createAuditReadCaller,
  isKeysetAuditRead,
  mapAuditRow,
} from "./audit-log";

const ULID_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ULID_B = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const DESTRUCTIVE_NAME_RE = /update|delete|clear|redact|remove|purge/i;

const writeInput = () => ({
  action: "admin.role_change",
  actor: "user:01J0XQT8Z9N3H6K2M5P7R9T1V3",
  actor_email: "admin@example.com",
  actor_role: "admin",
  target_type: "user",
  target_id: "user:target",
  metadata: { from: "member", to: "admin" },
  ip: "127.0.0.1",
  user_agent: "Mozilla/5.0 (X11; 'quoted')",
});

const entryRow = () => ({
  id: `audit_log:${ULID_A}`,
  action: "auth.sign_in",
  actor: "user:01J0XQT8Z9N3H6K2M5P7R9T1V3",
  actor_email: "person@example.com",
  actor_role: "member",
  target_type: "session",
  target_id: "session:1",
  metadata: { reason: "password" },
  ip: "127.0.0.1",
  user_agent: "Mozilla/5.0",
  timestamp: "2026-07-02T08:26:30.607511063Z",
});

describe("the tRPC read leg denies below-admin and never leaks rows", () => {
  test("a member calling the audit read is rejected FORBIDDEN with a generic message and reads no rows", async () => {
    const readAuditEntries = vi.fn(() => Promise.resolve([]));
    const caller = createAuditReadCaller({
      readAuditEntries,
      session: { user: { id: "user:m", role: "member" } },
    });
    const captured = await caller
      .list({ limit: 50 })
      .then(() => undefined)
      .catch((error: unknown) => auditReadErrorShape(error));
    expect(captured?.nativeCode).toBe("FORBIDDEN");
    expect(captured?.message).toBe(AUDIT_READ_FORBIDDEN_MESSAGE);
    // The denial must precede any read — a leaked page would defeat the perimeter.
    expect(readAuditEntries).not.toHaveBeenCalled();
  });

  test("an unauthenticated caller is rejected UNAUTHORIZED", async () => {
    const caller = createAuditReadCaller({
      readAuditEntries: () => Promise.resolve([]),
      session: null,
    });
    const captured = await caller
      .list({ limit: 50 })
      .then(() => undefined)
      .catch((error: unknown) => auditReadErrorShape(error));
    expect(captured?.nativeCode).toBe("UNAUTHORIZED");
  });

  test("an admin and a superadmin receive the keyset page", async () => {
    for (const role of ["admin", "superadmin"]) {
      const readAuditEntries = vi.fn(() =>
        Promise.resolve([mapAuditRow(entryRow())])
      );
      const caller = createAuditReadCaller({
        readAuditEntries,
        session: { user: { id: "user:a", role } },
      });
      const page = await caller.list({ limit: 50 });
      expect(page.entries).toHaveLength(1);
      expect(readAuditEntries).toHaveBeenCalledTimes(1);
    }
  });
});

describe("the audit write path is gated to system/admin flows", () => {
  test("a below-admin session cannot append; system and admin/superadmin can", () => {
    expect(authorizeAuditWrite({ kind: "session", role: "member" })).toBe(
      false
    );
    expect(authorizeAuditWrite({ kind: "session", role: "admin" })).toBe(true);
    expect(authorizeAuditWrite({ kind: "session", role: "superadmin" })).toBe(
      true
    );
    expect(authorizeAuditWrite({ kind: "system" })).toBe(true);
  });

  test("the write input rejects an out-of-vocabulary action and accepts a domain.verb action", () => {
    expect(
      auditWriteInputSchema.safeParse({
        ...writeInput(),
        action: "billing.charge",
      }).success
    ).toBe(false);
    expect(auditWriteInputSchema.safeParse(writeInput()).success).toBe(true);
  });

  test("the write SQL inlines the validated ULID id, binds free-text, inlines metadata, and rejects a non-ULID id", () => {
    const { query, vars } = buildAuditWriteSql(ULID_A, writeInput());
    expect(query).toContain(`type::record('audit_log', '${ULID_A}')`);
    // Arbitrary-byte fields are bound, never spliced into the statement body.
    expect(query).not.toContain("Mozilla");
    expect(vars.user_agent).toBe("Mozilla/5.0 (X11; 'quoted')");
    // metadata is an inlined JSON literal so it stores as an object.
    expect(query).toContain('"from":"member"');
    // It is an append, never a replacing UPSERT.
    expect(query.startsWith("CREATE ")).toBe(true);
    expect(() => buildAuditWriteSql("not-a-ulid", writeInput())).toThrow();
  });
});

describe("the read is an index-backed keyset walk (never OFFSET)", () => {
  test("the first page orders + limits with no WHERE/OFFSET", () => {
    const query = buildAuditKeysetSql({ limit: 50 } as AuditListInput);
    expect(query).toContain("ORDER BY id DESC");
    expect(query).toContain("LIMIT 50");
    expect(query).not.toContain("WHERE");
    expect(isKeysetAuditRead(query)).toBe(true);
  });

  test("a continuation page carries the keyset id predicate, not an OFFSET", () => {
    const query = buildAuditKeysetSql({ cursor: ULID_B, limit: 25 });
    expect(query).toContain(`id < type::record('audit_log', '${ULID_B}')`);
    expect(isKeysetAuditRead(query)).toBe(true);
  });

  test("the keyset guard rejects an OFFSET/START deep page (anti-vacuous)", () => {
    expect(
      isKeysetAuditRead(
        "SELECT * FROM audit_log ORDER BY id DESC LIMIT 50 START 100;"
      )
    ).toBe(false);
  });
});

describe("the read row maps to a validated canonical entry", () => {
  test("the record id becomes a bare ULID and the nanosecond datetime normalizes to ISO", () => {
    const entry = mapAuditRow(entryRow());
    expect(entry.id).toBe(ULID_A);
    expect(entry.timestamp).toBe("2026-07-02T08:26:30.607Z");
    expect(entry.action).toBe("auth.sign_in");
    expect(entry.metadata).toEqual({ reason: "password" });
  });
});

describe("the audit router surface is read-only", () => {
  test("every exposed procedure is a query and none is a destructive mutation", () => {
    const procedures = auditRouterProcedures();
    expect(procedures).toHaveLength(1);
    expect(procedures[0]?.name).toBe("list");
    for (const procedure of procedures) {
      expect(procedure.type).toBe("query");
      expect(procedure.name).not.toMatch(DESTRUCTIVE_NAME_RE);
    }
  });
});
