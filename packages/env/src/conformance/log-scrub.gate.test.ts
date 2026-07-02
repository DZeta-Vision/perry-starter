import { describe, expect, test } from "vitest";

// Conformance gate — the NFR secret scrubber strips every secret-bearing field
// from a log/alert record before it can reach any sink.
//
// The scrubber is the ONE redaction control shared by the edge Sentry
// `beforeSendLog` and the daemon's envelope + console emit. It is a KEY deny-list
// (recursive, case-insensitive): a field whose name denotes a secret is redacted
// to `[redacted]`, at any nesting depth, while benign audit context (event type +
// actor + non-secret ids) survives.
//
// The mutation twin (log-scrub.mutation.test.ts) proves a NON-scrubbing variant
// leaks the same denied field (the token/password), so this gate cannot be
// vacuously green.

const MODULE = "@perry-starter/env/scrub";

interface ScrubModule {
  isSecretFree: (value: unknown) => boolean;
  isSecretKey: (key: string) => boolean;
  REDACTED: string;
  scrubSecrets: <T>(value: T) => T;
}

const importScrub = async (): Promise<ScrubModule> =>
  (await import(MODULE)) as unknown as ScrubModule;

// A representative log record: a benign event + actor alongside secret-bearing
// fields at the top level AND nested in an object and an array element.
const logRecord = () => ({
  message: "auth.sign_in",
  actor: "user_01",
  userId: "user_01",
  sessionId: "sess_keep_me",
  password: "hunter2",
  token: "tok-super-secret",
  Authorization: "Bearer leak-me",
  headers: {
    "set-cookie": "sid=leak-me-too",
    apiKey: "ak-secret",
    accept: "application/json",
  },
  events: [{ cookie: "c-secret" }, { ok: "plain" }],
});

describe("the NFR secret scrubber strips every secret-bearing field at any depth", () => {
  test("the denied field `password` is removed (redacted), never passed through", async () => {
    const { scrubSecrets, REDACTED } = await importScrub();
    const scrubbed = scrubSecrets(logRecord()) as Record<string, unknown>;

    expect(scrubbed.password).toBe(REDACTED);
    expect(scrubbed.password).not.toBe("hunter2");
  });

  test("secret keys at top level, nested objects, and array elements are all redacted", async () => {
    const { scrubSecrets, REDACTED } = await importScrub();
    const scrubbed = scrubSecrets(logRecord()) as {
      token: string;
      Authorization: string;
      headers: { "set-cookie": string; apiKey: string; accept: string };
      events: Array<{ cookie?: string; ok?: string }>;
    };

    expect(scrubbed.token).toBe(REDACTED);
    expect(scrubbed.Authorization).toBe(REDACTED); // case-insensitive
    expect(scrubbed.headers["set-cookie"]).toBe(REDACTED);
    expect(scrubbed.headers.apiKey).toBe(REDACTED);
    expect(scrubbed.events[0]?.cookie).toBe(REDACTED);
  });

  test("no raw secret value survives anywhere in the serialized output", async () => {
    const { scrubSecrets } = await importScrub();
    const serialized = JSON.stringify(scrubSecrets(logRecord()));

    for (const secret of [
      "hunter2",
      "tok-super-secret",
      "Bearer leak-me",
      "sid=leak-me-too",
      "ak-secret",
      "c-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("benign event type + actor + non-secret ids are preserved verbatim", async () => {
    const { scrubSecrets } = await importScrub();
    const scrubbed = scrubSecrets(logRecord()) as Record<string, unknown> & {
      headers: { accept: string };
      events: Array<{ ok?: string }>;
    };

    expect(scrubbed.message).toBe("auth.sign_in");
    expect(scrubbed.actor).toBe("user_01");
    expect(scrubbed.userId).toBe("user_01");
    expect(scrubbed.sessionId).toBe("sess_keep_me"); // id, not a token → kept
    expect(scrubbed.headers.accept).toBe("application/json");
    expect(scrubbed.events[1]?.ok).toBe("plain");
  });

  test("isSecretKey classifies token/password/authorization/cookie/api-key, spares plain ids", async () => {
    const { isSecretKey } = await importScrub();

    for (const denied of [
      "password",
      "Authorization",
      "refreshToken",
      "Set-Cookie",
      "x-api-key",
      "clientSecret",
      "passphrase",
    ]) {
      expect(isSecretKey(denied)).toBe(true);
    }
    for (const allowed of [
      "actor",
      "sessionId",
      "userId",
      "message",
      "count",
    ]) {
      expect(isSecretKey(allowed)).toBe(false);
    }
  });

  test("isSecretFree is true for a clean record and false once a secret key is present", async () => {
    const { isSecretFree } = await importScrub();

    expect(isSecretFree({ message: "ok", actor: "u1", count: 3 })).toBe(true);
    expect(isSecretFree({ message: "ok", token: "leak" })).toBe(false);
  });
});
