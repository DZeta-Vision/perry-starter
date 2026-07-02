import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Acceptance tests for the cloud better-auth authority.
//
// Collection-safe: top-level imports are only `vitest` + `node:*`; the
// `@perry-starter/auth` singleton is dynamically imported, and every source
// file is read, inside the test bodies.
//
// These prove the singleton is the sole session/token issuer wired with the
// organization()+jwt(ES256)+bearer+admin plugin set over a custom SurrealDB
// adapter on the SURREAL_* contract, with ONE single-sourced access-control
// matrix shared across plugins, the GLOBAL member<admin<superadmin hierarchy,
// and the comma-separated org-structural member.role split.

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/auth/test
const AUTH_SRC = resolve(HERE, "..", "src"); // packages/auth/src

// --- comment-stripping + source collection (top-level regex literals) --------

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

const SKIP_DIRS = new Set(["node_modules", ".turbo", "dist", ".alchemy"]);

const collectTsFiles = (root: string): string[] => {
  if (!existsSync(root)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        out.push(...collectTsFiles(join(root, entry.name)));
      }
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.includes(".test.")
    ) {
      out.push(join(root, entry.name));
    }
  }
  return out;
};

const readSrc = (root: string): string =>
  collectTsFiles(root)
    .map((file) => stripJsComments(readFileSync(file, "utf8")))
    .join("\n");

// --- detectors (replicated in spirit by the in-test twins) -------------------

const ES256_KEYPAIR_RE = /keyPairConfig\s*:\s*\{[^}]*alg\s*:\s*["']ES256["']/;
const EDDSA_ALG_RE = /alg\s*:\s*["']EdDSA["']/;
const CREATE_ACCESS_CONTROL_RE = /createAccessControl\s*\(/g;
const ORG_PLUGIN_AC_RE = /organization\s*\(\s*\{[^}]*\bac\b/;
// The admin plugin reads the SAME `ac` via the extracted `adminPluginOptions` object
// (extracted so the hard-delete-block gate can assert the impersonation/hard-delete
// bypass surfaces stay unset). Proving the single matrix reaches admin means the
// options object carries `ac` AND the admin plugin is fed exactly those options.
const ADMIN_PLUGIN_OPTIONS_AC_RE = /adminPluginOptions\s*=\s*\{[^}]*\bac\b/;
const ADMIN_PLUGIN_USES_OPTIONS_RE = /admin\s*\(\s*adminPluginOptions\s*\)/;
const SURREAL_ADAPTER_RE = /createAdapterFactory\s*\(/;
const SURREAL_ADAPTER_ID_RE = /adapterId\s*:\s*["']surreal["']/;
const SURREAL_ENV_RE = /SURREAL_URL/;
const LEGACY_DB_URL_RE = /DATABASE_URL/;
const TODO_WIRE_ADAPTER_RE = /TODO:\s*wire the SurrealDB better-auth adapter/i;

const countMatches = (re: RegExp, source: string): number =>
  (source.match(re) ?? []).length;

// --- the dynamically imported singleton surface ------------------------------

interface BetterAuthPluginLike {
  readonly id?: string;
}
interface BetterAuthOptionsLike {
  readonly emailAndPassword?: {
    readonly enabled?: boolean;
    readonly minPasswordLength?: number;
    readonly maxPasswordLength?: number;
  };
  readonly plugins?: readonly BetterAuthPluginLike[];
  readonly user?: {
    readonly additionalFields?: Readonly<Record<string, unknown>>;
  };
}
interface AuthModule {
  readonly APP_ROLE_RANK: Readonly<Record<string, number>>;
  readonly auth: { readonly options: BetterAuthOptionsLike };
  readonly parseMemberRoles: (roleString: string) => string[];
  readonly roles: Readonly<Record<string, unknown>>;
}

const loadAuth = async (): Promise<AuthModule> =>
  (await import("@perry-starter/auth")) as unknown as AuthModule;

const pluginIds = (options: BetterAuthOptionsLike): string[] =>
  (options.plugins ?? [])
    .map((p) => p.id)
    .filter((id): id is string => typeof id === "string");

describe("the better-auth singleton is the sole authority with the org + jwt + bearer + admin plugin set", () => {
  test("the singleton registers the organization, jwt, bearer and admin plugins", async () => {
    const { auth } = await loadAuth();
    const ids = pluginIds(auth.options);
    for (const required of ["organization", "jwt", "bearer", "admin"]) {
      expect(ids).toContain(required);
    }
  });

  test("email and password sign-up enforces the 12-128 NIST length bounds", async () => {
    const { auth } = await loadAuth();
    expect(auth.options.emailAndPassword?.enabled).toBe(true);
    expect(auth.options.emailAndPassword?.minPasswordLength).toBe(12);
    expect(auth.options.emailAndPassword?.maxPasswordLength).toBe(128);
  });

  test("the user model exposes the locale, given_name and family_name additional fields", async () => {
    const { auth } = await loadAuth();
    const additionalFields = auth.options.user?.additionalFields ?? {};
    for (const field of ["locale", "given_name", "family_name"]) {
      expect(Object.hasOwn(additionalFields, field)).toBe(true);
    }
  });

  test("the jwt plugin pins ES256 and never falls back to the EdDSA default", () => {
    const source = readSrc(AUTH_SRC);
    expect(ES256_KEYPAIR_RE.test(source)).toBe(true);
    expect(EDDSA_ALG_RE.test(source)).toBe(false);
  });

  test("a planted EdDSA algorithm or a missing alg is caught by the algorithm scan", () => {
    // Anti-vacuous twin: the scan flags a fixture that leaves the JWKS on the
    // insecure EdDSA default rather than pinning ES256.
    const eddsaFixture = 'jwt({ jwks: { keyPairConfig: { alg: "EdDSA" } } })';
    const unsetFixture = "jwt({ jwks: { keyPairConfig: {} } })";
    expect(ES256_KEYPAIR_RE.test(eddsaFixture)).toBe(false);
    expect(EDDSA_ALG_RE.test(eddsaFixture)).toBe(true);
    expect(ES256_KEYPAIR_RE.test(unsetFixture)).toBe(false);
  });

  test("the database is a custom SurrealDB adapter wired from the SURREAL_ env contract", () => {
    const source = readSrc(AUTH_SRC);
    expect(SURREAL_ADAPTER_RE.test(source)).toBe(true);
    expect(SURREAL_ADAPTER_ID_RE.test(source)).toBe(true);
    expect(SURREAL_ENV_RE.test(source)).toBe(true);
    expect(LEGACY_DB_URL_RE.test(source)).toBe(false);
    expect(TODO_WIRE_ADAPTER_RE.test(source)).toBe(false);
  });

  test("a leftover DATABASE_URL or an unwired adapter is flagged", () => {
    // Anti-vacuous twin.
    const legacyFixture = "database: env.DATABASE_URL";
    const todoFixture = "// TODO: wire the SurrealDB better-auth adapter";
    expect(LEGACY_DB_URL_RE.test(legacyFixture)).toBe(true);
    expect(SURREAL_ADAPTER_RE.test(legacyFixture)).toBe(false);
    expect(TODO_WIRE_ADAPTER_RE.test(stripJsComments(todoFixture))).toBe(false);
    expect(TODO_WIRE_ADAPTER_RE.test(todoFixture)).toBe(true);
  });
});

describe("one access-control matrix and the global role hierarchy are single-sourced across the plugins", () => {
  test("the org-structural member role splits on commas into its component roles", async () => {
    const { parseMemberRoles } = await loadAuth();
    expect(parseMemberRoles("admin,member")).toEqual(["admin", "member"]);
    expect(parseMemberRoles("owner")).toEqual(["owner"]);
  });

  test("a member role string is never treated as one atomic multi-role value", async () => {
    const { parseMemberRoles } = await loadAuth();
    expect(parseMemberRoles("admin,member")).not.toEqual(["admin,member"]);
  });

  test("exactly one access-control matrix is built and shared by both the organization and admin plugins", () => {
    const source = readSrc(AUTH_SRC);
    // Single source: createAccessControl is called once; both org + admin read it.
    expect(countMatches(CREATE_ACCESS_CONTROL_RE, source)).toBe(1);
    expect(ORG_PLUGIN_AC_RE.test(source)).toBe(true);
    // The admin plugin reads that one `ac` via `adminPluginOptions` (which carries it)
    // and is fed exactly those options — no second matrix.
    expect(ADMIN_PLUGIN_OPTIONS_AC_RE.test(source)).toBe(true);
    expect(ADMIN_PLUGIN_USES_OPTIONS_RE.test(source)).toBe(true);
  });

  test("two divergent access-control matrices across the plugins are flagged", () => {
    // Anti-vacuous twin: a fixture that builds a second matrix instead of
    // sharing the one source trips the single-call detector.
    const driftedFixture = `
      const ac1 = createAccessControl(s1);
      const ac2 = createAccessControl(s2);
    `;
    expect(countMatches(CREATE_ACCESS_CONTROL_RE, driftedFixture)).toBe(2);
  });

  test("the global authorization roles are member, admin and superadmin ranked in order", async () => {
    const { roles, APP_ROLE_RANK } = await loadAuth();
    for (const role of ["member", "admin", "superadmin"]) {
      expect(roles[role]).toBeDefined();
    }
    expect(APP_ROLE_RANK.member).toBeLessThan(APP_ROLE_RANK.admin);
    expect(APP_ROLE_RANK.admin).toBeLessThan(APP_ROLE_RANK.superadmin);
  });

  test("a broken global hierarchy that drops superadmin or mis-orders the ranks is rejected", () => {
    // Anti-vacuous twin: an out-of-order / incomplete rank map fails the order
    // invariant the gate enforces over the real APP_ROLE_RANK.
    const brokenRank: Record<string, number> = { member: 2, admin: 1 };
    const ordered =
      brokenRank.member < brokenRank.admin &&
      typeof brokenRank.superadmin === "number" &&
      brokenRank.admin < brokenRank.superadmin;
    expect(ordered).toBe(false);
  });
});
