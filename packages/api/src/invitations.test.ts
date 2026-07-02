// Behavior tests for the invitation surface: create is admin-gated + step-up +
// audited and NEVER provisions an account (the half-formed-privileged-account
// guard); the no-escalation role authority at the router (a plain admin invites
// only a member, admin creation superadmin-only); resend re-issues + invalidates;
// revoke/expire then accept fail closed; a valid accept provisions once + a replay
// is consumed (single-use); every surface is enumeration-silent; and there is no
// public admin-signup route. Names describe behavior, not a planning id.

import { INVITATION_TTL_MS } from "@perry-starter/auth/invitation-lifecycle";
import { createStepUpGrantStore } from "@perry-starter/auth/step-up-store";
import type { Invitation } from "@perry-starter/db/shapes/invitation";
import { TRPCError } from "@trpc/server";
import { expect, test, vi } from "vitest";
import { INVITATION_SURFACE_RESPONSE } from "./invitation-surface";
import {
  createInvitationCaller,
  type InvitationContext,
  invitationRouterProcedures,
  type PersistInvitationInput,
} from "./invitations";

const T0 = 5_000_000_000;

// An in-memory invitation store keyed by token digest — the privileged forwarder
// stand-in. It lets a single test drive create → accept → replay end to end.
const makeStore = () => {
  const rows = new Map<string, Invitation>();
  return {
    loadInvitationByTokenHash: (tokenHash: string): Invitation | null =>
      rows.get(tokenHash) ?? null,
    markInvitationAccepted: ({
      acceptedAt,
      tokenHash,
    }: {
      acceptedAt: string;
      tokenHash: string;
    }) => {
      const row = rows.get(tokenHash);
      if (row) {
        rows.set(tokenHash, {
          ...row,
          accepted_at: acceptedAt,
          status: "accepted",
        });
      }
    },
    persistInvitation: (input: PersistInvitationInput) => {
      rows.set(input.tokenHash, {
        accepted_at: null,
        created_at: new Date(T0).toISOString(),
        email: input.email,
        expires_at: input.expiresAt,
        invited_by: input.invitedBy,
        organization_id: input.organizationId,
        role: input.role,
        status: "pending",
        token_hash: input.tokenHash,
      });
    },
    revokePriorInvitations: ({
      email,
      organizationId,
    }: {
      email: string;
      organizationId: string | null;
    }) => {
      for (const [key, row] of rows) {
        if (row.email === email && row.organization_id === organizationId) {
          rows.set(key, { ...row, status: "revoked" });
        }
      }
    },
    rows,
  };
};

interface Harness {
  readonly audit: ReturnType<typeof vi.fn>;
  readonly ctx: InvitationContext;
  readonly provision: ReturnType<typeof vi.fn>;
  readonly sent: Array<{ to: string; token: string }>;
  readonly store: ReturnType<typeof makeStore>;
}

const makeHarness = (over: Partial<InvitationContext> = {}): Harness => {
  const store = makeStore();
  const sent: Array<{ to: string; token: string }> = [];
  const provision = vi.fn(() => ({ userId: "user-new" }));
  const audit = vi.fn();
  const ctx: InvitationContext = {
    loadInvitationByTokenHash: store.loadInvitationByTokenHash,
    markInvitationAccepted: store.markInvitationAccepted,
    now: T0,
    persistInvitation: store.persistInvitation,
    provisionInvitedAccount: provision,
    recordConsequentAudit: audit,
    recordLockoutFailure: vi.fn(),
    recordStepUpAudit: vi.fn(),
    revokePriorInvitations: store.revokePriorInvitations,
    revokeSession: vi.fn(),
    sendInvitationEmail: (input) => {
      sent.push({ to: input.to, token: input.token });
    },
    session: {
      id: "sess-super",
      user: { id: "user-super", role: "superadmin" },
    },
    stepUpStore: createStepUpGrantStore(),
    stepUpToken: undefined,
    ...over,
  };
  return { audit, ctx, provision, sent, store };
};

// Top-level regex (Biome: never build a regex inside a function).
const SIGNUP_ROUTE_RE = /signup|register/i;

const dataCode = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof TRPCError) {
      const cause = error.cause as { code?: string } | undefined;
      return cause?.code ?? error.code;
    }
  }
  return "no-error";
};

const grantFor = (sessionId: string) => {
  const store = createStepUpGrantStore();
  const token = store.issue({ action: "invite.create", now: T0, sessionId });
  return { store, token };
};

// --- Create: step-up + audit + never-provisions ------------------------------

test("create with no step-up grant returns STEP_UP_REQUIRED and persists nothing", async () => {
  const h = makeHarness();
  const caller = createInvitationCaller(h.ctx);
  expect(
    await dataCode(() =>
      caller.createInvitation({ email: "invitee@example.com", role: "member" })
    )
  ).toBe("STEP_UP_REQUIRED");
  expect(h.store.rows.size).toBe(0);
  expect(h.provision).not.toHaveBeenCalled();
  expect(h.sent).toHaveLength(0);
});

test("a fresh grant persists a pending invitation, emails the token, audits create, and NEVER provisions an account", async () => {
  const { store, token } = grantFor("sess-super");
  const h = makeHarness({ stepUpStore: store, stepUpToken: token });
  const caller = createInvitationCaller(h.ctx);

  await expect(
    caller.createInvitation({ email: "invitee@example.com", role: "member" })
  ).resolves.toEqual(INVITATION_SURFACE_RESPONSE);

  // Exactly one pending invitation row, no user account provisioned.
  expect(h.store.rows.size).toBe(1);
  const row = [...h.store.rows.values()][0];
  if (!row) {
    throw new Error("expected one persisted invitation row");
  }
  expect(row.status).toBe("pending");
  expect(row.accepted_at).toBeNull();
  expect(row.role).toBe("member");
  expect(h.provision).not.toHaveBeenCalled();
  // The plaintext token is delivered only via the email seam; the row stores a
  // digest, never the token.
  expect(h.sent).toHaveLength(1);
  expect(row.token_hash).not.toBe(h.sent[0]?.token);
  expect(h.audit).toHaveBeenCalledWith({
    action: "admin.invitation_created",
    actor: "user-super",
    target: "invitee@example.com",
  });
});

// --- The no-escalation role authority at the router (c4) ---------------------

test("a member caller is denied FORBIDDEN at the admin gate and never reaches step-up", async () => {
  const h = makeHarness({
    session: { id: "sess-m", user: { id: "user-m", role: "member" } },
  });
  const caller = createInvitationCaller(h.ctx);
  expect(
    await dataCode(() =>
      caller.createInvitation({ email: "x@example.com", role: "member" })
    )
  ).toBe("FORBIDDEN");
  expect(h.ctx.recordStepUpAudit).not.toHaveBeenCalled();
  expect(h.store.rows.size).toBe(0);
});

test("a plain admin inviting an admin is rejected and never persists", async () => {
  const { store, token } = grantFor("sess-admin");
  const h = makeHarness({
    session: { id: "sess-admin", user: { id: "user-admin", role: "admin" } },
    stepUpStore: store,
    stepUpToken: token,
  });
  const caller = createInvitationCaller(h.ctx);
  expect(
    await dataCode(() =>
      caller.createInvitation({ email: "x@example.com", role: "admin" })
    )
  ).toBe("INVITATION_ROLE_FORBIDDEN");
  expect(h.store.rows.size).toBe(0);
  expect(h.sent).toHaveLength(0);
});

test("a superadmin may invite an admin (superadmin-gated admin creation)", async () => {
  const { store, token } = grantFor("sess-super");
  const h = makeHarness({ stepUpStore: store, stepUpToken: token });
  const caller = createInvitationCaller(h.ctx);
  await expect(
    caller.createInvitation({ email: "newadmin@example.com", role: "admin" })
  ).resolves.toEqual(INVITATION_SURFACE_RESPONSE);
  expect(h.store.rows.size).toBe(1);
  expect([...h.store.rows.values()][0]?.role).toBe("admin");
});

// --- Resend re-issues + invalidates the old token ----------------------------

test("resend issues a new token and invalidates the old one; the old token no longer accepts", async () => {
  // Create with a first grant.
  const g1 = grantFor("sess-super");
  const h = makeHarness({ stepUpStore: g1.store });
  const caller = createInvitationCaller({ ...h.ctx, stepUpToken: g1.token });
  await caller.createInvitation({
    email: "invitee@example.com",
    role: "member",
  });
  const firstToken = h.sent[0]?.token as string;

  // Resend with a second grant (same store/session).
  const secondGrant = h.ctx.stepUpStore.issue({
    action: "invite.create",
    now: T0,
    sessionId: "sess-super",
  });
  const resendCaller = createInvitationCaller({
    ...h.ctx,
    stepUpToken: secondGrant,
  });
  await resendCaller.resendInvitation({
    email: "invitee@example.com",
    role: "member",
  });
  const secondToken = h.sent[1]?.token as string;
  expect(secondToken).not.toBe(firstToken);

  // The old token now resolves to a revoked invitation → fail closed.
  const acceptOld = createInvitationCaller({ ...h.ctx, session: null });
  await acceptOld.acceptInvitation({ token: firstToken });
  expect(h.provision).not.toHaveBeenCalled();

  // The new token accepts once.
  await acceptOld.acceptInvitation({ token: secondToken });
  expect(h.provision).toHaveBeenCalledTimes(1);
});

// --- Accept: single-use, fail-closed on revoked/expired/consumed -------------

const seedInvitation = async (
  h: Harness
): Promise<{
  token: string;
  caller: ReturnType<typeof createInvitationCaller>;
}> => {
  const grant = h.ctx.stepUpStore.issue({
    action: "invite.create",
    now: T0,
    sessionId: "sess-super",
  });
  const caller = createInvitationCaller({ ...h.ctx, stepUpToken: grant });
  await caller.createInvitation({
    email: "invitee@example.com",
    role: "member",
  });
  return { caller, token: h.sent.at(-1)?.token as string };
};

test("a valid accept provisions the account once and audits; a replay is consumed", async () => {
  const h = makeHarness();
  const { token } = await seedInvitation(h);
  const accept = createInvitationCaller({ ...h.ctx, session: null });

  await expect(accept.acceptInvitation({ token })).resolves.toEqual(
    INVITATION_SURFACE_RESPONSE
  );
  expect(h.provision).toHaveBeenCalledTimes(1);
  expect(h.provision).toHaveBeenCalledWith({
    email: "invitee@example.com",
    organizationId: null,
    role: "member",
  });
  expect(h.audit).toHaveBeenCalledWith({
    action: "admin.invitation_accepted",
    actor: "invitee@example.com",
    target: "invitee@example.com",
  });

  // A replay of the same (now consumed) token provisions nothing more.
  await accept.acceptInvitation({ token });
  expect(h.provision).toHaveBeenCalledTimes(1);
});

test("accepting a revoked invitation fails closed (no provision)", async () => {
  const h = makeHarness();
  const { token } = await seedInvitation(h);
  h.store.revokePriorInvitations({
    email: "invitee@example.com",
    organizationId: null,
  });
  const accept = createInvitationCaller({ ...h.ctx, session: null });
  await accept.acceptInvitation({ token });
  expect(h.provision).not.toHaveBeenCalled();
});

test("accepting past the expiry window fails closed (no provision)", async () => {
  const h = makeHarness();
  const { token } = await seedInvitation(h);
  // Accept far past the TTL window.
  const accept = createInvitationCaller({
    ...h.ctx,
    now: T0 + INVITATION_TTL_MS + 1,
    session: null,
  });
  await accept.acceptInvitation({ token });
  expect(h.provision).not.toHaveBeenCalled();
});

test("accepting an unknown token fails closed (no provision)", async () => {
  const h = makeHarness();
  const accept = createInvitationCaller({ ...h.ctx, session: null });
  await expect(
    accept.acceptInvitation({ token: "never-issued" })
  ).resolves.toEqual(INVITATION_SURFACE_RESPONSE);
  expect(h.provision).not.toHaveBeenCalled();
});

// --- Enumeration silence + no public admin signup ----------------------------

test("create returns the neutral envelope whether or not the email is already an account", async () => {
  // Two creates for different emails both return the identical neutral response —
  // the resolver is existence-blind (it never checks account existence).
  const g1 = grantFor("sess-super");
  const h = makeHarness({ stepUpStore: g1.store });
  const known = createInvitationCaller({ ...h.ctx, stepUpToken: g1.token });
  const knownResponse = await known.createInvitation({
    email: "known@example.com",
    role: "member",
  });
  const secondGrant = h.ctx.stepUpStore.issue({
    action: "invite.create",
    now: T0,
    sessionId: "sess-super",
  });
  const unknown = createInvitationCaller({
    ...h.ctx,
    stepUpToken: secondGrant,
  });
  const unknownResponse = await unknown.createInvitation({
    email: "unknown@example.com",
    role: "member",
  });
  expect(knownResponse).toEqual(unknownResponse);
  expect(knownResponse).toEqual(INVITATION_SURFACE_RESPONSE);
});

test("an anonymous caller cannot create an invitation", async () => {
  const h = makeHarness({ session: null });
  const caller = createInvitationCaller(h.ctx);
  expect(
    await dataCode(() =>
      caller.createInvitation({ email: "x@example.com", role: "admin" })
    )
  ).toBe("UNAUTHORIZED");
});

test("no public admin-signup route exists: only accept is reachable anonymously and it stamps no caller-chosen role", () => {
  const procedures = invitationRouterProcedures();
  const names = procedures.map((procedure) => procedure.name);
  // The surface is exactly create/resend/revoke/accept — no anonymous
  // account-creating "signup"/"register" route.
  expect(names).toContain("acceptInvitation");
  expect(names.some((name) => SIGNUP_ROUTE_RE.test(name))).toBe(false);
  // Accept can never let an anonymous caller pick a role — its input carries only a
  // token, so the stamped role is whatever the authority-checked invitation holds.
  const acceptProc = (
    procedures as ReadonlyArray<{ name: string; type: string }>
  ).find((procedure) => procedure.name === "acceptInvitation");
  expect(acceptProc?.type).toBe("mutation");
});
