import {
  adminProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from "../index";

export const appRouter = router({
  healthCheck: publicProcedure.query(() => "OK"),
  privateData: protectedProcedure.query(({ ctx }) => ({
    message: "This is private",
    user: ctx.session.user,
  })),
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
});
export type AppRouter = typeof appRouter;
