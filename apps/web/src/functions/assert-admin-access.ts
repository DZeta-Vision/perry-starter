import {
  adminDoorSeams,
  evaluateAdminCheckpoint,
  runAdminDoor,
} from "@perry-starter/api/admin-checkpoint";
import { createServerFn } from "@tanstack/react-start";

import { authMiddleware } from "@/middleware/auth";

// The ONE admin-surface checkpoint, run server-side. `authMiddleware` re-resolves
// the session from the authority (the worker gatekeeper) over HTTP — never a
// client-supplied claim — and the pure `evaluateAdminCheckpoint` decides. Because
// the decision is a pure function of the authority-resolved session with no
// server-vs-client branch, and this ONE server function is what the admin route's
// isomorphic `beforeLoad` invokes on both the SSR render and a client navigation,
// the verdict is identical on both paths. A below-admin (or unverified, or
// malformed) session is denied; the checkpoint never produces admin content.
//
// On denial the non-admin door fires: it best-effort invalidates the admin-surface
// session and emits the audit event, but it is fail-closed — a failure in either
// step never turns the deny into an allow. The concrete revoke + audit sinks are
// injected (the worker wires the authority's revoke + audit write); the deny +
// no-leak hold regardless.
const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

export const assertAdminAccess = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const session = context.session as {
      user?: { id?: unknown; email?: unknown; role?: unknown };
    } | null;
    const decision = evaluateAdminCheckpoint(session);
    if (decision.allow) {
      return { allow: true } as const;
    }
    const user = session?.user ?? {};
    await runAdminDoor(
      {
        actor: str(user.id) || "anonymous",
        actor_email: str(user.email) || "unknown",
        actor_role: str(user.role) || "member",
        ip: "unknown",
        target_id: "admin",
        user_agent: "unknown",
      },
      adminDoorSeams()
    );
    return { allow: false } as const;
  });
