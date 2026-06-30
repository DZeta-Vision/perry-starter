import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Acceptance tests for the package dependency direction + the cloud auth
// gatekeeper. Collection-safe: top-level imports are only `vitest` + `node:*`;
// every source file is read inside the test bodies.
//
// These prove: no auth-decision code path leaks into apps/web or apps/daemon
// (the client never issues sessions/tokens); packages/auth imports only
// packages/db + packages/env (never api/infra) with the user/org shapes
// single-sourced; and exactly one runtime cloud-SurrealDB binding exists,
// living on the gatekeeper worker rather than the web relay.

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/auth/test
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const AUTH_SRC = join(REPO_ROOT, "packages", "auth", "src");
const AUTH_PKG_JSON = join(REPO_ROOT, "packages", "auth", "package.json");
const WEB_SRC = join(REPO_ROOT, "apps", "web", "src");
const DAEMON_SRC = join(REPO_ROOT, "apps", "daemon", "src");
const WORKER_DIR = join(REPO_ROOT, "apps", "worker");
const INFRA_PROGRAM = join(REPO_ROOT, "packages", "infra", "alchemy.run.ts");

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

const IMPORT_SPECIFIER_RE =
  /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

const importSpecifiers = (source: string): string[] => {
  const code = stripJsComments(source);
  const hits: string[] = [];
  for (const match of code.matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      hits.push(specifier);
    }
  }
  return hits;
};

// --- no auth-decision (token issuance) code path on the client tiers --------

const BETTER_AUTH_CONSTRUCT_RE = /\bbetterAuth\s*\(/;

// A specifier is an auth-decision (issuance) import if it pulls the server
// authority. The browser auth CLIENT (better-auth/client, /react) only CALLS
// the authority and is allowed.
const isAuthorityImport = (specifier: string): boolean => {
  if (specifier === "@perry-starter/auth") {
    return true;
  }
  if (specifier.startsWith("@perry-starter/auth/")) {
    return true;
  }
  if (specifier === "better-auth") {
    return true;
  }
  if (specifier.startsWith("better-auth/plugins")) {
    return true;
  }
  if (specifier.startsWith("better-auth/adapters")) {
    return true;
  }
  return false;
};

const authorityImportsIn = (root: string): string[] => {
  const hits: string[] = [];
  for (const file of collectTsFiles(root)) {
    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (isAuthorityImport(specifier)) {
        hits.push(`${file}: ${specifier}`);
      }
    }
    if (BETTER_AUTH_CONSTRUCT_RE.test(stripJsComments(source))) {
      hits.push(`${file}: betterAuth(`);
    }
  }
  return hits;
};

// --- dependency direction (auth imports only db + env) ----------------------

const isUpwardImport = (specifier: string): boolean =>
  specifier === "@perry-starter/api" ||
  specifier.startsWith("@perry-starter/api/") ||
  specifier === "@perry-starter/infra" ||
  specifier.startsWith("@perry-starter/infra/");

const upwardImportsIn = (root: string): string[] => {
  const hits: string[] = [];
  for (const file of collectTsFiles(root)) {
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      if (isUpwardImport(specifier)) {
        hits.push(`${file}: ${specifier}`);
      }
    }
  }
  return hits;
};

// --- the single runtime cloud-SurrealDB binding (one cloud door) ------------

const WORKER_DECL_RE = /(?:Worker|TanStackStart)\s*\(\s*["']([^"']+)["']/g;
const SURREAL_PASS_RE = /SURREAL_PASS/g;
const USER_SCHEMA_DECL_RE = /\buserSchema\s*=\s*z\.object\s*\(/;
const ORG_SCHEMA_DECL_RE = /\borganizationSchema\s*=\s*z\.object\s*\(/;

// Map each runtime SURREAL_PASS binding back to the worker that declares it,
// returning the set of distinct worker names that hold a cloud-SurrealDB cred.
const workersBindingCloudSurreal = (programSource: string): string[] => {
  const code = stripJsComments(programSource);
  const decls: { index: number; name: string }[] = [];
  for (const match of code.matchAll(WORKER_DECL_RE)) {
    decls.push({ index: match.index ?? 0, name: match[1] ?? "" });
  }
  const owners = new Set<string>();
  for (const match of code.matchAll(SURREAL_PASS_RE)) {
    const at = match.index ?? 0;
    let owner = "";
    for (const decl of decls) {
      if (decl.index <= at) {
        owner = decl.name;
      }
    }
    if (owner !== "") {
      owners.add(owner);
    }
  }
  return [...owners];
};

describe("no auth-decision code path exists on the client tiers", () => {
  test("neither the web app nor the daemon imports the server authority or constructs better-auth", () => {
    expect(authorityImportsIn(WEB_SRC)).toEqual([]);
    expect(authorityImportsIn(DAEMON_SRC)).toEqual([]);
  });

  test("the detector flags a server-singleton import or a betterAuth() construction but allows the browser auth client", () => {
    // Anti-vacuous twin, both directions.
    expect(isAuthorityImport("@perry-starter/auth")).toBe(true);
    expect(isAuthorityImport("better-auth")).toBe(true);
    expect(isAuthorityImport("better-auth/plugins")).toBe(true);
    expect(BETTER_AUTH_CONSTRUCT_RE.test("const a = betterAuth({})")).toBe(
      true
    );
    // The browser CALLS the authority — these are not issuance and stay allowed.
    expect(isAuthorityImport("better-auth/client")).toBe(false);
    expect(isAuthorityImport("better-auth/react")).toBe(false);
  });
});

describe("packages/auth imports only db and env, with the identity shapes single-sourced", () => {
  test("the auth package depends on db and env but never on api or infra", () => {
    const pkg = JSON.parse(readFileSync(AUTH_PKG_JSON, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = pkg.dependencies ?? {};
    expect(deps["@perry-starter/db"]).toBeDefined();
    expect(deps["@perry-starter/env"]).toBeDefined();
    expect(deps["@perry-starter/api"]).toBeUndefined();
    expect(deps["@perry-starter/infra"]).toBeUndefined();
  });

  test("the auth source imports nothing from the api or infra packages", () => {
    expect(upwardImportsIn(AUTH_SRC)).toEqual([]);
  });

  test("the user and organization shapes are imported from db rather than redeclared in auth", () => {
    const source = collectTsFiles(AUTH_SRC)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const importsIdentityFromDb = importSpecifiers(source).some(
      (specifier) =>
        specifier === "@perry-starter/db" ||
        specifier.startsWith("@perry-starter/db/")
    );
    expect(importsIdentityFromDb).toBe(true);
    // No inline canonical user/organization schema redeclaration in auth.
    const code = stripJsComments(source);
    expect(USER_SCHEMA_DECL_RE.test(code)).toBe(false);
    expect(ORG_SCHEMA_DECL_RE.test(code)).toBe(false);
  });

  test("an upward import into api or infra is flagged by the direction detector", () => {
    // Anti-vacuous twin.
    expect(isUpwardImport("@perry-starter/api")).toBe(true);
    expect(isUpwardImport("@perry-starter/infra")).toBe(true);
    expect(isUpwardImport("@perry-starter/db")).toBe(false);
    expect(isUpwardImport("@perry-starter/env/server")).toBe(false);
  });

  test("a duplicated user-shape declaration in the auth package is flagged", () => {
    // Anti-vacuous twin.
    const duplicated =
      "export const userSchema = z.object({ id: z.string() });";
    expect(USER_SCHEMA_DECL_RE.test(duplicated)).toBe(true);
  });
});

describe("exactly one runtime cloud-SurrealDB binding lives on the gatekeeper worker", () => {
  test("the infra program declares exactly one worker holding a runtime cloud-SurrealDB credential", () => {
    const owners = workersBindingCloudSurreal(
      readFileSync(INFRA_PROGRAM, "utf8")
    );
    expect(owners).toHaveLength(1);
  });

  test("the single runtime cloud-SurrealDB binding lives on the gatekeeper worker, not the web relay", () => {
    const owners = workersBindingCloudSurreal(
      readFileSync(INFRA_PROGRAM, "utf8")
    );
    expect(owners).toHaveLength(1);
    expect(owners[0]).not.toBe("web");
  });

  test("the apps/worker auth host exists as the gatekeeper ingress", () => {
    expect(existsSync(WORKER_DIR)).toBe(true);
  });

  test("an infra program binding cloud SurrealDB on two workers is flagged", () => {
    // Anti-vacuous twin: two runtime cloud bindings violate the one-door rule.
    const twoBindings = `
      export const web = await TanStackStart("web", { bindings: { SURREAL_PASS: alchemy.secret.env.SURREAL_PASS } });
      export const api = await Worker("gatekeeper", { bindings: { SURREAL_PASS: alchemy.secret.env.SURREAL_PASS } });
    `;
    expect(workersBindingCloudSurreal(twoBindings)).toHaveLength(2);
  });

  test("an infra program placing the runtime cloud binding on the web relay is flagged", () => {
    // Anti-vacuous twin: the lone binding on the relay worker fails the
    // gatekeeper-placement rule.
    const onRelay = `
      export const web = await TanStackStart("web", { bindings: { SURREAL_PASS: alchemy.secret.env.SURREAL_PASS } });
    `;
    const owners = workersBindingCloudSurreal(onRelay);
    expect(owners).toEqual(["web"]);
  });
});
