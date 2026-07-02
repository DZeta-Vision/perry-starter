// The fail-closed admin access checkpoint + the enumeration-silent non-admin door.
//
// ONE server-side structural decision re-resolves the authority-issued session,
// reads the DB-sourced GLOBAL role claim, requires `emailVerified`, and rejects
// below-admin BEFORE any admin content is produced. The role decision derives
// from the ONE single-sourced role->capability matrix (the `user:list`
// admin-surface hinge in @perry-starter/auth) — never a client-supplied claim —
// so the auth library cannot introduce a divergent admin role and the two
// enforcement legs cannot drift.
//
// The verdict is a PURE function of the resolved session with no environment
// branch, so it is IDENTICAL whether it runs during the SSR render or a client
// navigation: the route's isomorphic `beforeLoad` calls the same server function
// on both paths, and that function calls this one decision. A checkpoint error
// DENIES (fail-closed), it never allows.

import { holdsAdminSurface } from "@perry-starter/auth/rbac";

// Generic, enumeration-silent denial copy: it never names the admin resource or
// the required role, so a below-admin caller learns only "no access", not that an
// admin surface exists behind the URL. Shared wording with the audit-read denial.
export const ADMIN_DENIED_MESSAGE = "Insufficient role for this scope";

// The `<domain>.<verb>` action the non-admin door records (domain `admin`).
export const ADMIN_DOOR_ACTION = "admin.access_denied";

// A FORBIDDEN-class denial envelope. `FORBIDDEN` is the native tRPC/HTTP class the
// frontend maps to the one generic no-access surface; no field enumerates a
// resource or a role.
export interface AdminDenialEnvelope {
  readonly code: "FORBIDDEN";
  readonly message: string;
  readonly ok: false;
}

export const adminDenial = (): AdminDenialEnvelope => ({
  code: "FORBIDDEN",
  message: ADMIN_DENIED_MESSAGE,
  ok: false,
});

export interface AdminCheckpointDecision {
  readonly allow: boolean;
}

const DENY: AdminCheckpointDecision = { allow: false };
const ALLOW: AdminCheckpointDecision = { allow: true };

interface ResolvedClaims {
  readonly emailVerified: boolean;
  readonly role: string;
}

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

// Pull the DB-sourced GLOBAL role + `emailVerified` off the authority-resolved
// session. Tolerant of both the get-session envelope (`{ user, session, ...proj }`,
// where the projection also lifts `role` to the top level) and a bare projected
// claim. It reads ONLY server-resolved fields — a client-supplied role is never
// consulted. A missing/malformed shape yields an empty role + unverified, so the
// checkpoint fails closed.
const readSessionClaims = (raw: unknown): ResolvedClaims => {
  const envelope = (raw ?? {}) as {
    user?: { role?: unknown; emailVerified?: unknown };
    role?: unknown;
    emailVerified?: unknown;
  };
  const user = envelope.user ?? {};
  const role = str(user.role) || str(envelope.role);
  const emailVerified =
    user.emailVerified === true || envelope.emailVerified === true;
  return { emailVerified, role };
};

// The one fail-closed decision. A checkpoint that trusts a client claim, forgets
// the verification requirement, or throws on a malformed session would fail OPEN;
// this one denies on every one of those.
export const evaluateAdminCheckpoint = (
  rawSession: unknown
): AdminCheckpointDecision => {
  try {
    if (!rawSession) {
      return DENY;
    }
    const { role, emailVerified } = readSessionClaims(rawSession);
    if (!emailVerified) {
      return DENY;
    }
    if (!holdsAdminSurface(role)) {
      return DENY;
    }
    return ALLOW;
  } catch {
    // A thrown error (a hostile/undeserializable session) DENIES, never allows.
    return DENY;
  }
};

// --- The non-admin door ------------------------------------------------------

// The audit event the door records for an attempt on the admin surface.
export interface AdminDoorAudit {
  readonly action: string;
  readonly actor: string;
  readonly actor_email: string;
  readonly actor_role: string;
  readonly ip: string;
  readonly metadata: Record<string, unknown>;
  readonly target_id: string;
  readonly target_type: string;
  readonly user_agent: string;
}

// The claims the door stamps onto its audit event, gathered from the resolved
// session (the actor being turned away).
export interface AdminDoorClaims {
  readonly actor: string;
  readonly actor_email: string;
  readonly actor_role: string;
  readonly ip: string;
  readonly target_id: string;
  readonly user_agent: string;
}

export interface AdminDoorSeams {
  // Emit the audit event recording the attempt. It MAY reject/throw; swallowed
  // (the deny stands regardless).
  readonly recordAudit: (event: AdminDoorAudit) => Promise<void> | void;
  // Invalidate the caller's session for the admin surface. It MAY reject/throw;
  // the door swallows that and STILL denies — fail-closed even if revoke fails.
  readonly revokeAdminSession: () => Promise<void> | void;
}

// Fire the non-admin door. It ALWAYS returns the generic denial envelope: it best-
// effort invalidates the admin-surface session and emits the audit event, but a
// failure in EITHER step never turns the denial into an allow — the door has no
// success path out of it, so it is fail-closed by construction.
export const runAdminDoor = async (
  claims: AdminDoorClaims,
  seams: AdminDoorSeams
): Promise<AdminDenialEnvelope> => {
  try {
    await seams.revokeAdminSession();
  } catch {
    // Fail-closed: a failed revoke does not open the door.
  }
  try {
    await seams.recordAudit({
      action: ADMIN_DOOR_ACTION,
      actor: claims.actor,
      actor_email: claims.actor_email,
      actor_role: claims.actor_role,
      ip: claims.ip,
      metadata: {},
      target_id: claims.target_id,
      target_type: "admin_surface",
      user_agent: claims.user_agent,
    });
  } catch {
    // Fail-closed: a failed audit write does not open the door.
  }
  return adminDenial();
};

// --- Worker-wireable default seams (injected sink, like the auth-audit sink) ---
//
// The web app is a pure session READER (it holds no auth singleton); the authority
// (worker) owns session revocation and the audit write. So the concrete revoke +
// audit are INJECTED here and default to safe no-ops — the door's fail-closed
// deny + no-leak are guaranteed regardless of whether a sink is wired.

const NOOP_REVOKE: AdminDoorSeams["revokeAdminSession"] = () => undefined;
const NOOP_AUDIT: AdminDoorSeams["recordAudit"] = () => undefined;

let revokeSink: AdminDoorSeams["revokeAdminSession"] = NOOP_REVOKE;
let auditSink: AdminDoorSeams["recordAudit"] = NOOP_AUDIT;

export const configureAdminDoorSeams = (
  next: Partial<AdminDoorSeams>
): void => {
  if (next.revokeAdminSession) {
    revokeSink = next.revokeAdminSession;
  }
  if (next.recordAudit) {
    auditSink = next.recordAudit;
  }
};

export const resetAdminDoorSeams = (): void => {
  revokeSink = NOOP_REVOKE;
  auditSink = NOOP_AUDIT;
};

export const adminDoorSeams = (): AdminDoorSeams => ({
  recordAudit: (event) => auditSink(event),
  revokeAdminSession: () => revokeSink(),
});
