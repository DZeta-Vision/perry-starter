import { describe, expect, test } from "vitest";

// Mutation twin for sidecar-hardening.gate.test.ts (source leg). Plants a
// dropped deny-flag / bind and a root-cred read and asserts each reddens, with
// clean controls. (The behavioral control — a sidecar WITHOUT --deny-scripting
// lets the scripting query return OK — lives in the acceptance file, paired with
// the deny-cap effectiveness proof.)

const REQUIRED_HARDENING = [
  "--bind",
  "127.0.0.1",
  "--deny-guests",
  "--deny-scripting",
  "--deny-net",
] as const;

const findMissingHardening = (source: string): string[] =>
  REQUIRED_HARDENING.filter((flag) => !source.includes(flag));

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /(^|[^:])\/\/.*$/gm;
const stripJsComments = (source: string): string =>
  source.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "$1");

const BEARER_AUTH_RE = /kind\s*:\s*["']bearer["']/;
const ROOT_CREDENTIAL_RES = [/\bSURREAL_USER\b/, /\bSURREAL_PASS\b/] as const;
const usesBearerAuth = (source: string): boolean =>
  BEARER_AUTH_RE.test(stripJsComments(source));
const findRootCredentialReads = (source: string): string[] => {
  const code = stripJsComments(source);
  return ROOT_CREDENTIAL_RES.filter((re) => re.test(code)).map(
    (re) => re.source
  );
};

// A complete, hardened spawn-args control: loopback bind + all three deny flags.
const HARDENED_ARGS =
  '["start","--bind","127.0.0.1:0","--deny-guests","--deny-scripting","--deny-net","memory"]';

describe("the spawn-args detector fires when a deny flag or the bind is dropped", () => {
  test("dropping --deny-scripting reddens (a missing flag is reported)", () => {
    const dropped = HARDENED_ARGS.replace('"--deny-scripting",', "");
    expect(findMissingHardening(dropped).length).toBeGreaterThan(0);
  });

  test("dropping the loopback bind reddens", () => {
    const dropped = HARDENED_ARGS.replace('"--bind","127.0.0.1:0",', "");
    expect(findMissingHardening(dropped).length).toBeGreaterThan(0);
  });

  test("the fully-hardened spawn-args stay green (not always-red)", () => {
    expect(findMissingHardening(HARDENED_ARGS)).toEqual([]);
  });
});

describe("the Bearer-not-root detector resists comments and fires on planted root reads", () => {
  test("a planted env.SURREAL_USER read in the query path reddens", () => {
    const leak =
      "const auth = { user: env.SURREAL_USER, pass: env.SURREAL_PASS };";
    expect(findRootCredentialReads(leak).length).toBeGreaterThan(0);
  });

  test("a root credential named only inside a comment does NOT redden", () => {
    expect(
      findRootCredentialReads("// never read SURREAL_USER here\nconst x = 1;")
    ).toEqual([]);
  });

  test("an actual object-literal Bearer auth satisfies the Bearer check", () => {
    expect(usesBearerAuth('const auth = { kind: "bearer", token };')).toBe(
      true
    );
  });

  test("a Bearer mention only inside a comment does NOT satisfy the Bearer check", () => {
    expect(usesBearerAuth('// kind: "bearer"\nconst x = 1;')).toBe(false);
  });
});
