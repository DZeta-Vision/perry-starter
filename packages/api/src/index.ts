import { resolveGlobalRoles, roles } from "@perry-starter/auth/rbac";
import { initTRPC, TRPCError } from "@trpc/server";

import type { Context } from "./context";

export const t = initTRPC.context<Context>().create();

export const router = t.router;

export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
      cause: "No session",
    });
  }
  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
    },
  });
});

// --- The tRPC RBAC middleware leg (AD-9 first authorization layer) -----------
//
// It authorizes against the ONE single-sourced matrix in @perry-starter/auth,
// reading the GLOBAL admin-plugin role claim (user.role) split on ',' — never an
// org-structural role. A denial throws the nearest native tRPC code (FORBIDDEN)
// and carries the precise AD-21 code in shape.data.code via the errorFormatter.
// This leg is necessary but NOT sufficient — the SurrealDB row-level PERMISSIONS
// (generated from the same matrix) are the second leg; neither alone grants.

interface RbacContext {
  readonly session: {
    readonly user: { readonly id: string; readonly role: string };
  } | null;
}

interface AuthorizingRole {
  readonly authorize: (
    request: Record<string, readonly string[]>,
    connector?: "AND" | "OR"
  ) => { readonly success: boolean };
}
const ROLES = roles as unknown as Record<string, AuthorizingRole | undefined>;

// The cross-user oversight capability: reading another user's resources requires
// the admin tier's `user:list` capability, which member lacks and admin/superadmin
// hold. Derived from the single matrix, so it cannot drift from the row leg.
const CROSS_USER_READ = { user: ["list"] } as const;

// AD-21 envelope: SESSION_EXPIRED / ACCOUNT_LOCKED etc. are NOT valid TRPCError
// codes, so the precise code rides in shape.data.code. For an authorization denial
// the precise code IS the native FORBIDDEN; a richer denial may attach its own
// code via the error cause.
const adCodeForError = (error: unknown): string | undefined => {
  if (error instanceof TRPCError) {
    const cause = error.cause as { code?: string } | undefined;
    return cause?.code ?? error.code;
  }
  return;
};

const tRbac = initTRPC.context<RbacContext>().create({
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: { ...shape.data, code: adCodeForError(error) ?? shape.data.code },
  }),
});

// Allow iff ANY resolved GLOBAL tier grants the capability; multi-role claims
// ("admin,member") are split on ','.
const authorizeGlobalRole = (
  request: Record<string, readonly string[]>,
  roleClaim: string
): boolean =>
  resolveGlobalRoles({ user: { role: roleClaim } }).some((tier) => {
    const role = ROLES[tier];
    return role ? role.authorize(request, "AND").success : false;
  });

// The RBAC .use() leg, layered on a session check; it runs BEFORE input parsing.
const rbacProcedure = (request: Record<string, readonly string[]>) =>
  tRbac.procedure.use(({ ctx, next }) => {
    if (!ctx.session) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }
    if (!authorizeGlobalRole(request, ctx.session.user.role)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Insufficient role for this scope",
      });
    }
    return next();
  });

const crossUserReadRouter = tRbac.router({
  // Reading a document outside the caller's own scope is a cross-user oversight
  // action — denied for member, granted for admin/superadmin.
  readForeignDocument: rbacProcedure(CROSS_USER_READ).query(() => ({
    id: "documents:foreign",
  })),
});

// An in-process caller for the cross-user read path (no network), exercising the
// middleware leg's deny/allow decision directly.
export const createCrossUserReadCaller = (ctx: RbacContext) =>
  crossUserReadRouter.createCaller(ctx);

// Project a thrown error into its native tRPC code + the AD-21 shape.data.code.
export const toErrorShape = (
  error: unknown
): { readonly dataCode?: string; readonly nativeCode?: string } => {
  if (error instanceof TRPCError) {
    return { nativeCode: error.code, dataCode: adCodeForError(error) };
  }
  return {};
};
