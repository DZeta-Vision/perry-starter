// Mutation twin for the content-type source-guard: it replicates the guard's
// detector and feeds it a fixture using the forbidden, silently-ignored header
// setter — asserting the detector flags it (so the gate would redden). A clean
// `reply.type(...)` fixture is the green control.

import { describe, expect, test } from "vitest";

const REPLY_HEADER_CONTENT_TYPE_RE = /reply\.header\(\s*["']content-type["']/i;

const detectsForbiddenSetter = (source: string): boolean =>
  REPLY_HEADER_CONTENT_TYPE_RE.test(source);

const FORBIDDEN_DOUBLE =
  'reply.header("content-type", "text/html").send(html);';
const FORBIDDEN_SINGLE =
  "reply.header('content-type', 'text/html').send(html);";
const CLEAN = 'reply.type("text/html").send(html);';

describe("the content-type source-guard flags the silently-ignored reply.header setter", () => {
  test("a double-quoted reply.header('content-type') is detected", () => {
    expect(detectsForbiddenSetter(FORBIDDEN_DOUBLE)).toBe(true);
  });

  test("a single-quoted reply.header('content-type') is detected", () => {
    expect(detectsForbiddenSetter(FORBIDDEN_SINGLE)).toBe(true);
  });

  test("a clean reply.type() handler stays green (not always-firing)", () => {
    expect(detectsForbiddenSetter(CLEAN)).toBe(false);
  });
});
