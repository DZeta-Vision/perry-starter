// The acceptance harness drives the REAL better-auth authority.
//
// It builds the authority from the SAME `buildAuthOptions` the shipped singleton
// uses — same plugins, same fail-open breach-screen `before` hook, same
// registration/session database hooks, same `auth.options` — swapping ONLY the
// storage adapter (an in-memory adapter for an isolated round-trip instead of
// SurrealDB-over-HTTP). Every surface is reached through `auth.handler` (the exact
// ingress the worker fronts) and wrapped by the production `normalizeAuthResponse`,
// so no proof here asserts a property of a code path production does not run. This
// is cloud/worker tier — never the daemon.

import { localeSchema } from "@perry-starter/db/shapes/identity";
import { env } from "@perry-starter/env/server";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { normalizeAuthResponse } from "./anti-enumeration";
import { configureAuthAudit, resetAuthAudit } from "./auth-audit";
import {
  consumeVerificationToken,
  NEUTRAL_VERIFICATION_REJECTION_COPY,
  VERIFICATION_TOKEN_TTL_SECONDS,
  type VerificationTokenRecord,
} from "./email-verification";
import { configureHibpRangeFetch, resetHibpRangeFetch } from "./hibp-screen";
import { buildAuthOptions } from "./index";
import { type RangeFetch, sha1HexUpper } from "./password-policy";
import {
  type PersonalOrgStore,
  personalOrgIdFor,
  provisionPersonalOrg,
} from "./personal-org";
import {
  configureVerificationEmailSender,
  dispatchVerificationEmail,
  type VerificationEmailSender,
} from "./verification-email";

const ORIGIN = env.BETTER_AUTH_URL;

// An email whose verification send simulates a Resend API error (the discriminated
// `{ data, error }` union, never a throw).
const RESEND_ERROR_EMAIL = "resend-error@example.com";

// The known-breached fixture: its SHA-1 prefix is what the reachable range double
// reports a hit for; every other password screens clean when HIBP is reachable.
const BREACHED_PASSWORD = "password1234";

// A fresh in-memory store with every model table the plugin set touches
// pre-initialized (the memory adapter throws on a read before the table exists).
const freshDb = (): Record<string, unknown[]> => ({
  account: [],
  invitation: [],
  jwks: [],
  member: [],
  organization: [],
  session: [],
  team: [],
  teamMember: [],
  user: [],
  verification: [],
});

// The reachable range double: a hit ONLY for the breached fixture whose SHA-1
// prefix matches the queried prefix; plus a count-0 padding line so the body is
// always non-empty (mirroring the real Add-Padding response).
const reachableHibpFetch: RangeFetch = async (url) => {
  const prefix = (url.split("/").pop() ?? "").toUpperCase();
  const lines: string[] = [];
  const hash = await sha1HexUpper(BREACHED_PASSWORD);
  if (hash.slice(0, 5) === prefix) {
    lines.push(`${hash.slice(5)}:42`);
  }
  lines.push("0000000000000000000000000000000000A:0");
  return { ok: true, text: () => Promise.resolve(lines.join("\r\n")) };
};

const unreachableHibpFetch: RangeFetch = () =>
  Promise.reject(new Error("ENOTFOUND api.pwnedpasswords.com"));

export interface CapturedEmail {
  readonly error: unknown;
  readonly locale: string;
  readonly template: string;
  readonly variables: Record<string, unknown>;
}

export interface SignUpInput {
  readonly email: string;
  readonly familyName?: string;
  readonly givenName?: string;
  readonly locale?: string;
  readonly password: string;
}

export interface SignUpOutcome {
  readonly body: unknown;
  readonly emailVerified: boolean | null;
  readonly locale: string | null;
  readonly orgRole: string | null;
  readonly role: string | null;
  readonly setAuthTokenHeader: string | null;
  readonly setCookieHeader: string | null;
  readonly status: number;
  readonly userId: string | null;
}

export interface SignInOutcome {
  readonly setAuthTokenHeader: string | null;
  readonly status: number;
  readonly token: string | null;
}

export interface SurfaceResponse {
  readonly body: unknown;
  readonly headers: Record<string, string>;
  readonly status: number;
}

type Authority = ReturnType<typeof betterAuth>;

interface SignUpResponseBody {
  readonly token?: string | null;
  readonly user?: {
    readonly emailVerified?: boolean;
    readonly id?: string;
    readonly locale?: string;
    readonly role?: string;
  };
}

const post = (
  authority: Authority,
  path: string,
  body: unknown
): Promise<Response> =>
  authority.handler(
    new Request(`${ORIGIN}/api/auth${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin: ORIGIN },
      method: "POST",
    })
  );

const verifyByToken = (
  authority: Authority,
  token: string
): Promise<Response> =>
  authority.handler(
    new Request(
      `${ORIGIN}/api/auth/verify-email?token=${encodeURIComponent(token)}`,
      { headers: { origin: ORIGIN }, method: "GET" }
    )
  );

const toSurface = async (response: Response): Promise<SurfaceResponse> => {
  const text = await response.text();
  return {
    body: text.length > 0 ? JSON.parse(text) : null,
    headers: Object.fromEntries(response.headers.entries()),
    status: response.status,
  };
};

// A single authority + its capture buffers. Every helper drives `auth.handler`.
const createAuthorityContext = () => {
  const db = freshDb();
  const audits: string[] = [];
  const emails: CapturedEmail[] = [];

  configureAuthAudit((action) => {
    audits.push(action);
  });
  configureHibpRangeFetch(reachableHibpFetch);

  const sender: VerificationEmailSender = (intent) => {
    const error =
      intent.to === RESEND_ERROR_EMAIL ? { name: "application_error" } : null;
    emails.push({
      error,
      locale: intent.locale,
      template: intent.template,
      variables: { ...intent.variables },
    });
    return Promise.resolve({
      data: error ? null : { id: `email-${emails.length}` },
      error,
    });
  };
  configureVerificationEmailSender(sender);

  const authority = betterAuth(buildAuthOptions(memoryAdapter(db)));

  const orgRoleFor = (userId: string | null): string | null => {
    if (!userId) {
      return null;
    }
    const member = (
      db.member as Array<{ userId?: string; role?: string }>
    ).find((row) => row.userId === userId);
    return member?.role ?? null;
  };

  const signUp = async (input: SignUpInput): Promise<SignUpOutcome> => {
    const response = await post(authority, "/sign-up/email", {
      email: input.email,
      family_name: input.familyName ?? "User",
      given_name: input.givenName ?? "Member",
      locale: input.locale,
      name: `${input.givenName ?? "Member"} ${input.familyName ?? "User"}`,
      password: input.password,
    });
    const setAuthTokenHeader = response.headers.get("set-auth-token");
    const setCookieHeader = response.headers.get("set-cookie");
    const text = await response.text();
    const body: SignUpResponseBody = text.length > 0 ? JSON.parse(text) : {};
    const userId = body.user?.id ?? null;
    return {
      body,
      emailVerified: body.user?.emailVerified ?? null,
      locale: body.user?.locale ?? null,
      orgRole: orgRoleFor(userId),
      role: body.user?.role ?? null,
      setAuthTokenHeader,
      setCookieHeader,
      status: response.status,
      userId,
    };
  };

  const signIn = async (input: {
    email: string;
    password: string;
  }): Promise<SignInOutcome> => {
    const response = await post(authority, "/sign-in/email", input);
    const setAuthTokenHeader = response.headers.get("set-auth-token");
    const text = await response.text();
    const body = (text.length > 0 ? JSON.parse(text) : {}) as {
      token?: string | null;
    };
    return {
      setAuthTokenHeader,
      status: response.status,
      token: body.token ?? null,
    };
  };

  const verifyEmail = (token: string): Promise<Response> =>
    verifyByToken(authority, token);

  // Resolve the session the bearer session-token belongs to (the projected
  // get-session body carries `activeOrganizationId`).
  const getSession = async (
    sessionToken: string
  ): Promise<{ activeOrganizationId?: string } & Record<string, unknown>> => {
    const response = await authority.handler(
      new Request(`${ORIGIN}/api/auth/get-session`, {
        headers: { authorization: `Bearer ${sessionToken}`, origin: ORIGIN },
        method: "GET",
      })
    );
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) : {};
  };

  const withUnreachableHibp = async <T>(run: () => Promise<T>): Promise<T> => {
    configureHibpRangeFetch(unreachableHibpFetch);
    try {
      return await run();
    } finally {
      configureHibpRangeFetch(reachableHibpFetch);
    }
  };

  return {
    auditActions: () => audits.slice(),
    authority,
    db,
    getSession,
    sentEmails: () => emails.slice(),
    signIn,
    signUp,
    verifyEmail,
    withUnreachableHibp,
  };
};

export type AuthorityContext = ReturnType<typeof createAuthorityContext>;

// The acceptance authority: the REAL options + handler-driven flows.
export const createTestAuthority = () => {
  const ctx = createAuthorityContext();
  return {
    auditActions: ctx.auditActions,
    getSession: ctx.getSession,
    options: ctx.authority.options,
    sentEmails: ctx.sentEmails,
    signIn: ctx.signIn,
    signUp: ctx.signUp,
    verifyEmail: ctx.verifyEmail,
    withUnreachableHibp: ctx.withUnreachableHibp,
  };
};

// ── The verification-token-lifecycle harness ───────────────────────────────────
//
// Drives the REAL packages/{auth,db} verification modules: the constrained
// locale-domain shape (localeSchema), the bilingual dispatch
// (dispatchVerificationEmail), the single-use TTL-bounded token lifecycle
// (consumeVerificationToken), and the ONE neutral rejection copy — over an
// in-memory token store with the wall-clock. NOTE: better-auth's production
// `/verify-email` uses its OWN stateless signed-JWT verification tokens, so this
// module is a PARALLEL verification surface; the single-use / expired-vs-unknown
// neutrality it proves are properties of THIS module, not of better-auth's token
// verification. (Reconciling the two onto one path is a separate concern.)
const MS_PER_SECOND = 1000;
const EXPIRED_OFFSET_MS = 1000;

export const createVerificationHarness = () => {
  const now = () => Date.now();
  const tokens = new Map<string, VerificationTokenRecord>();
  const provisionedOrgs = new Set<string>();
  let counter = 0;

  const signUp = async (input: {
    email: string;
    locale?: string;
    password: string;
  }) => {
    const localeResult = localeSchema.safeParse(input.locale);
    if (!localeResult.success) {
      throw new Error("LOCALE_OUT_OF_DOMAIN");
    }
    const locale = localeResult.data;
    counter += 1;
    const userId = `user-${counter}`;

    const store: PersonalOrgStore = {
      createMembership: () => undefined,
      createOrganization: (organization) => {
        provisionedOrgs.add(organization.id);
      },
    };
    await provisionPersonalOrg({ given_name: "Member", id: userId }, store);

    const verifyToken = crypto.randomUUID();
    const expiredVerifyToken = crypto.randomUUID();
    tokens.set(verifyToken, {
      consumed: false,
      expiresAtMs: now() + VERIFICATION_TOKEN_TTL_SECONDS * MS_PER_SECOND,
      token: verifyToken,
      userId,
    });
    tokens.set(expiredVerifyToken, {
      consumed: false,
      expiresAtMs: now() - EXPIRED_OFFSET_MS,
      token: expiredVerifyToken,
      userId,
    });

    let sentLocale: string = locale;
    await dispatchVerificationEmail(
      {
        locale,
        to: input.email,
        verifyToken,
        verifyUrl: `${ORIGIN}/api/auth/verify-email?token=${verifyToken}`,
      },
      {
        audit: () => undefined,
        send: (intent) => {
          sentLocale = intent.locale;
          return Promise.resolve({ data: { id: "verification" }, error: null });
        },
      }
    );

    return {
      account: { locale },
      expiredVerifyToken,
      sentLocale,
      verifyToken,
    };
  };

  const verify = (token: string) => {
    const result = consumeVerificationToken(tokens, token, now());
    if (!(result.ok && result.userId)) {
      // Expired / already-consumed / unknown all collapse to the SAME neutral copy.
      return Promise.resolve({
        activeOrganizationId: null,
        emailVerified: false,
        rejectionCopy: NEUTRAL_VERIFICATION_REJECTION_COPY,
        wallCleared: false,
      });
    }
    const orgId = personalOrgIdFor(result.userId);
    return Promise.resolve({
      activeOrganizationId: provisionedOrgs.has(orgId) ? orgId : null,
      emailVerified: true,
      rejectionCopy: null,
      wallCleared: true,
    });
  };

  return { signUp, verify };
};

// ── The cross-surface anti-enumeration matrix ──────────────────────────────────
//
// One authority per matrix run, so the divergent accounts a test materializes do
// not bleed across tests. The surface drivers below operate on THIS authority.
let matrix: AuthorityContext | null = null;

const currentMatrix = (): AuthorityContext => {
  if (!matrix) {
    matrix = createAuthorityContext();
  }
  return matrix;
};

const VALID_MATRIX_PASSWORD = "correct horse battery";

// Materialize one REAL account per pre-auth state behind the surfaces, then return
// the state→email map. `unregistered` deliberately creates no account (the absent
// state). `verified`/`registered` are signed up AND email-verified; `unverified`/
// `pending` are signed up but left unverified — genuine divergence the normalizer
// must hide. Resets the authority first so each matrix run starts clean.
export const seedEmailMatrix = async (
  states: readonly string[]
): Promise<Record<string, string>> => {
  matrix = createAuthorityContext();
  const ctx = matrix;
  const fixtures: Record<string, string> = {};
  for (const state of states) {
    const email = `${state}@matrix.example.com`;
    fixtures[state] = email;
    if (state === "unregistered") {
      continue;
    }
    await ctx.signUp({ email, password: VALID_MATRIX_PASSWORD });
    if (state === "verified" || state === "registered") {
      const token = ctx.sentEmails().at(-1)?.variables.verifyToken;
      if (typeof token === "string") {
        await ctx.verifyEmail(token);
      }
    }
  }
  return fixtures;
};

// Sign-up surface as the WORKER serves it: auth.handler wrapped by the production
// normalizer. The result is what a caller actually observes.
export const signUp = async (email: string): Promise<SurfaceResponse> => {
  const ctx = currentMatrix();
  const request = new Request(`${ORIGIN}/api/auth/sign-up/email`, {
    body: JSON.stringify({
      email,
      family_name: "User",
      given_name: "Member",
      name: "Member User",
      password: VALID_MATRIX_PASSWORD,
    }),
    headers: { "content-type": "application/json", origin: ORIGIN },
    method: "POST",
  });
  const raw = await ctx.authority.handler(request.clone());
  return toSurface(await normalizeAuthResponse(request, raw));
};

// Verification-resend surface as the worker serves it (auth.handler + normalizer).
export const resendVerification = async (
  email: string
): Promise<SurfaceResponse> => {
  const ctx = currentMatrix();
  const request = new Request(`${ORIGIN}/api/auth/send-verification-email`, {
    body: JSON.stringify({ email }),
    headers: { "content-type": "application/json", origin: ORIGIN },
    method: "POST",
  });
  const raw = await ctx.authority.handler(request.clone());
  return toSurface(await normalizeAuthResponse(request, raw));
};

// The RAW (un-normalized) sign-up surface — what better-auth returns before the
// worker wrapper. Used by the mutation twin to prove the wrapper is load-bearing
// (the raw responses embed the submitted email and so diverge by state).
export const rawSignUp = async (email: string): Promise<SurfaceResponse> => {
  const ctx = currentMatrix();
  return toSurface(
    await ctx.authority.handler(
      new Request(`${ORIGIN}/api/auth/sign-up/email`, {
        body: JSON.stringify({
          email,
          family_name: "User",
          given_name: "Member",
          name: "Member User",
          password: VALID_MATRIX_PASSWORD,
        }),
        headers: { "content-type": "application/json", origin: ORIGIN },
        method: "POST",
      })
    )
  );
};

// Sign-in surface (raw vs normalized) for the sign-in anti-enumeration proofs.
export const signInRaw = async (
  email: string,
  password: string
): Promise<SurfaceResponse> => {
  const ctx = currentMatrix();
  return toSurface(
    await ctx.authority.handler(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        body: JSON.stringify({ email, password }),
        headers: { "content-type": "application/json", origin: ORIGIN },
        method: "POST",
      })
    )
  );
};

export const signInNormalized = async (
  email: string,
  password: string
): Promise<SurfaceResponse> => {
  const ctx = currentMatrix();
  const request = new Request(`${ORIGIN}/api/auth/sign-in/email`, {
    body: JSON.stringify({ email, password }),
    headers: { "content-type": "application/json", origin: ORIGIN },
    method: "POST",
  });
  const raw = await ctx.authority.handler(request.clone());
  return toSurface(await normalizeAuthResponse(request, raw));
};

// Tear down the injected module-level singletons (audit/HIBP/email) between files.
export const resetAuthHarness = (): void => {
  matrix = null;
  resetAuthAudit();
  resetHibpRangeFetch();
};
