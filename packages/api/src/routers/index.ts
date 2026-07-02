import { auditRouter } from "../audit-log";
import { complianceRouter } from "../data-export";
import {
  adminProcedure,
  protectedProcedure,
  publicProcedure,
  router,
  stepUpRouter,
} from "../index";
import { invitationRouter } from "../invitations";
import { userAdminRouter } from "../user-admin";

// The ONE served surface. The session-only legs (healthCheck/privateData/admin.summary)
// stay as-is; the admin/compliance sub-routers — audit read, user administration,
// per-action step-up, and the invitation lifecycle — are MOUNTED here as nested
// sub-routers on the SAME `t`, so the whole privileged backend is a single router.
// Each mounted procedure is authorization-gated in its own middleware and FAILS
// CLOSED when the host has not injected its SurrealDB-backed sink (the relay tier),
// so mounting them on the relay never exposes privileged data.
export const appRouter = router({
  admin: router({
    // The admin surface's data, served ONLY through the role-gated admin tier
    // (derived from the ONE matrix). The admin page reads its data here; the
    // mis-tier build guard forbids an admin page fetching admin data through the
    // auth-only (non-role-gated) tier instead of this one.
    summary: adminProcedure.query(({ ctx }) => ({
      ok: true,
      role: (ctx.session.user as { role?: string }).role ?? "",
    })),
  }),
  audit: auditRouter,
  // Self-service GDPR data export: a signed-in member exports ONLY their own
  // records, server-scoped to `session.user.id`. Fails closed on the relay.
  compliance: complianceRouter,
  healthCheck: publicProcedure.query(() => "OK"),
  invitation: invitationRouter,
  privateData: protectedProcedure.query(({ ctx }) => ({
    message: "This is private",
    user: ctx.session.user,
  })),
  stepUp: stepUpRouter,
  userAdmin: userAdminRouter,
});
export type AppRouter = typeof appRouter;
