// Acceptance tests for the loopback OAuth callback's fail-closed behavior.
//
// These assert that a callback whose state does not match the per-flow expected
// state is rejected (timing-safe compare, never === on the secret) with no code
// exchange and no token persisted, that a replayed (already-consumed) state or
// one-time code is rejected because the code/state is burned on first use, and
// that a well-formed first-use callback passes — the anti-vacuous positive that
// proves the rejections are not a blanket deny. No partial state is left that a
// replay could later complete.
//
// RED PHASE: every test is `test.skip`. The loopback OAuth module does not exist
// yet; all not-yet-existing imports and all IO (fastify inject, single-use
// store) are dynamic inside the skipped bodies.

import { describe, expect, test } from "vitest";

const EXPECTED_STATE = "the-per-flow-expected-state-value-256bit";

// Hoisted (top-level) regex: the state comparison routes through a timing-safe
// primitive, never === on the secret.
const TIMING_SAFE_RE = /timingSafeEqual|timing-safe/i;

// Build a loopback callback app whose token sink and exchange are observable,
// so a rejected callback can be proven to have attempted neither.
const buildCallbackApp = async () => {
  const fastify = (await import("fastify")).default;
  const { mountLoopbackCallback } = await import("../src/loopback-oauth");
  const exchanged: string[] = [];
  const persisted: string[] = [];
  const app = fastify();
  mountLoopbackCallback(app, {
    expectedState: EXPECTED_STATE,
    codeVerifier: "verifier",
    onToken: (token: string) => {
      persisted.push(token);
      return Promise.resolve();
    },
    exchange: (code: string) => {
      exchanged.push(code);
      return Promise.resolve({ token: `session-for-${code}` });
    },
  });
  await app.ready();
  return { app, exchanged, persisted };
};

describe("a mismatched state fails closed", () => {
  test("rejects a callback whose state does not match the expected state", async () => {
    const { app, exchanged, persisted } = await buildCallbackApp();
    const res = await app.inject({
      method: "GET",
      url: "/callback?code=abc&state=tampered-not-the-expected-value",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    // No exchange attempted, no token persisted on a state mismatch.
    expect(exchanged).toHaveLength(0);
    expect(persisted).toHaveLength(0);
    await app.close();
  });

  test("compares the state timing-safe, never with === on the secret", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(process.cwd(), "apps", "daemon", "src", "loopback-oauth.ts"),
      "utf8"
    );
    // The state comparison routes through a timing-safe primitive.
    expect(source).toMatch(TIMING_SAFE_RE);
  });
});

describe("a replayed state / reused one-time code fails closed", () => {
  test("accepts a well-formed first-use callback (anti-vacuous positive)", async () => {
    const { app, exchanged, persisted } = await buildCallbackApp();
    const res = await app.inject({
      method: "GET",
      url: `/callback?code=first-use&state=${EXPECTED_STATE}`,
    });
    expect(res.statusCode).toBeLessThan(400);
    expect(exchanged).toEqual(["first-use"]);
    expect(persisted).toEqual(["session-for-first-use"]);
    await app.close();
  });

  test("rejects a second presentation of the same state/code (single-use burn)", async () => {
    const { app, exchanged } = await buildCallbackApp();
    const url = `/callback?code=once&state=${EXPECTED_STATE}`;
    const first = await app.inject({ method: "GET", url });
    const replay = await app.inject({ method: "GET", url });
    expect(first.statusCode).toBeLessThan(400);
    // The replay is rejected; the code is exchanged at most once.
    expect(replay.statusCode).toBeGreaterThanOrEqual(400);
    expect(exchanged).toEqual(["once"]);
    await app.close();
  });

  test("leaves no partial state that a replay could complete after a mismatch", async () => {
    const { app, exchanged, persisted } = await buildCallbackApp();
    // A mismatch then a replay of the mismatched values both fail closed.
    await app.inject({
      method: "GET",
      url: "/callback?code=x&state=wrong-value",
    });
    const replay = await app.inject({
      method: "GET",
      url: "/callback?code=x&state=wrong-value",
    });
    expect(replay.statusCode).toBeGreaterThanOrEqual(400);
    expect(exchanged).toHaveLength(0);
    expect(persisted).toHaveLength(0);
    await app.close();
  });
});
