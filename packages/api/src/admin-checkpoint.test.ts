// Fail-closed admin checkpoint + non-admin door — node unit proofs.
//
// The checkpoint re-resolves the DB-sourced role from the ONE matrix, requires
// emailVerified, and denies everything below admin; a malformed/hostile session
// denies (fail-closed). The door always denies with a generic enumeration-silent
// envelope, emits an audit event, and stays closed even when the revoke step
// throws. The admin role decision derives from the single-sourced matrix (never a
// divergent role, never a client claim).

import { ADMIN_TIER_ROLES } from "@perry-starter/auth";
import { adminTierRoles, holdsAdminSurface } from "@perry-starter/auth/rbac";
import { describe, expect, test, vi } from "vitest";
import {
  ADMIN_DENIED_MESSAGE,
  ADMIN_DOOR_ACTION,
  type AdminDoorAudit,
  adminDenial,
  evaluateAdminCheckpoint,
  runAdminDoor,
} from "./admin-checkpoint";

const verified = (role: string) => ({
  user: { email: "actor@example.test", id: "user:1", role },
});

// Every principal that must be turned away at the admin surface.
const BELOW_ADMIN = [
  { label: "no session", session: null },
  { label: "verified member", session: verified("member") },
  { label: "empty role", session: verified("") },
  {
    label: "org-structural owner (not a global admin)",
    session: verified("owner"),
  },
  { label: "unknown role", session: verified("auditor") },
  {
    label: "unverified admin",
    session: {
      user: {
        email: "a@example.test",
        id: "user:2",
        role: "admin",
        emailVerified: false,
      },
    },
  },
] as const;

describe("the admin checkpoint fails closed and derives its role decision from the one matrix", () => {
  test("a verified admin and a verified superadmin are admitted", () => {
    expect(
      evaluateAdminCheckpoint({
        user: { ...verified("admin").user, emailVerified: true },
      }).allow
    ).toBe(true);
    expect(
      evaluateAdminCheckpoint({
        user: { ...verified("superadmin").user, emailVerified: true },
      }).allow
    ).toBe(true);
  });

  test("a verified multi-role claim containing admin is admitted", () => {
    expect(
      evaluateAdminCheckpoint({
        user: { ...verified("admin,member").user, emailVerified: true },
      }).allow
    ).toBe(true);
  });

  test("denies every below-admin, unverified, or absent session (adversarial sweep)", () => {
    for (const { session } of BELOW_ADMIN) {
      expect(evaluateAdminCheckpoint(session).allow).toBe(false);
    }
  });

  test("a verified admin whose role rides only the top-level projected claim is admitted", () => {
    // The get-session projection lifts `role`/`emailVerified` to the top level too.
    expect(
      evaluateAdminCheckpoint({ role: "admin", emailVerified: true }).allow
    ).toBe(true);
  });

  test("a hostile session whose getters throw denies (a checkpoint error never allows)", () => {
    const hostile = {
      get user(): never {
        throw new Error("undeserializable session");
      },
    };
    expect(evaluateAdminCheckpoint(hostile).allow).toBe(false);
  });

  test("a client-supplied role is never trusted — only the resolved session role decides", () => {
    // There is no separate client-claim input to the checkpoint: the ONLY input is
    // the authority-resolved session. A member session cannot smuggle an admin
    // decision by carrying extra fields.
    const memberWithBogusClaim = {
      user: {
        email: "m@example.test",
        id: "user:3",
        role: "member",
        emailVerified: true,
      },
      claimedRole: "superadmin",
      isAdmin: true,
    };
    expect(evaluateAdminCheckpoint(memberWithBogusClaim).allow).toBe(false);
  });

  test("the verdict is a pure function of the session — identical on the server render and a client navigation", () => {
    // Same input, no environment branch: the ONE isomorphic server function that
    // beforeLoad calls on both paths yields the same verdict every time.
    const principals = [
      null,
      verified("member"),
      { user: { ...verified("admin").user, emailVerified: true } },
      { user: { ...verified("superadmin").user, emailVerified: true } },
    ];
    for (const principal of principals) {
      const onServerRender = evaluateAdminCheckpoint(principal);
      const onClientNav = evaluateAdminCheckpoint(principal);
      expect(onServerRender).toEqual(onClientNav);
    }
  });

  test("the admitted tiers equal the matrix-derived admin role set fed to the auth library", () => {
    // The checkpoint admits exactly the tiers the matrix grants the admin-surface
    // capability, and that is exactly the set handed to the admin() plugin — so the
    // auth library cannot introduce a divergent admin role.
    const admittedByCheckpoint = ["member", "admin", "superadmin"].filter(
      (tier) => holdsAdminSurface(tier)
    );
    expect(admittedByCheckpoint).toEqual(["admin", "superadmin"]);
    expect([...adminTierRoles()].sort()).toEqual(["admin", "superadmin"]);
    expect([...ADMIN_TIER_ROLES].sort()).toEqual(["admin", "superadmin"]);
  });
});

const claims = {
  actor: "user:9",
  actor_email: "member@example.test",
  actor_role: "member",
  ip: "203.0.113.7",
  target_id: "admin",
  user_agent: "probe/1.0",
};

describe("the non-admin door is enumeration-silent, audited, and fail-closed", () => {
  test("returns a generic FORBIDDEN-class envelope that names no resource or role", () => {
    const envelope = adminDenial();
    expect(envelope.code).toBe("FORBIDDEN");
    expect(envelope.ok).toBe(false);
    expect(envelope.message).toBe(ADMIN_DENIED_MESSAGE);
    // No enumeration: the copy names neither "admin" nor a role nor the resource.
    expect(envelope.message.toLowerCase()).not.toContain("admin");
  });

  test("emits an admin.* audit event recording the attempt", async () => {
    const recordAudit = vi.fn();
    const revokeAdminSession = vi.fn();
    const result = await runAdminDoor(claims, {
      recordAudit,
      revokeAdminSession,
    });
    expect(result.ok).toBe(false);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const event = (recordAudit.mock.calls[0]?.[0] ?? {}) as AdminDoorAudit;
    expect(event.action).toBe(ADMIN_DOOR_ACTION);
    expect(event.action.startsWith("admin.")).toBe(true);
    expect(event.actor).toBe(claims.actor);
    expect(event.target_type).toBe("admin_surface");
  });

  test("stays closed (still denies) even when the session-revoke step itself fails", async () => {
    const recordAudit = vi.fn();
    const revokeAdminSession = vi.fn(() => {
      throw new Error("revoke unavailable");
    });
    const result = await runAdminDoor(claims, {
      recordAudit,
      revokeAdminSession,
    });
    expect(result).toEqual(adminDenial());
    // The audit still fires despite the revoke failure.
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  test("stays closed even when the audit write itself fails", async () => {
    const revokeAdminSession = vi.fn();
    const recordAudit = vi.fn(() =>
      Promise.reject(new Error("audit sink down"))
    );
    const result = await runAdminDoor(claims, {
      recordAudit,
      revokeAdminSession,
    });
    expect(result).toEqual(adminDenial());
  });

  test("stays closed even when BOTH the revoke and the audit fail", async () => {
    const result = await runAdminDoor(claims, {
      recordAudit: () => {
        throw new Error("audit down");
      },
      revokeAdminSession: () => {
        throw new Error("revoke down");
      },
    });
    expect(result).toEqual(adminDenial());
  });
});
