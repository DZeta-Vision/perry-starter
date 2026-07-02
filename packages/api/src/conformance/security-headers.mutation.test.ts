// Mutation twin for security-headers.gate.test.ts.
//
// It proves the gate is anti-vacuous: the gate trusts `missingSecurityHeaders` to
// report an incomplete header set, so this twin feeds that SAME predicate a
// response that DROPS exactly one header on exactly one branch (success, error,
// OR redirect) and asserts it reddens — while the REAL `withSecurityHeaders`
// output on every branch stays green. A gate whose predicate could never see a
// dropped header would be a false guarantee; this twin forecloses that.

import {
  buildContentSecurityPolicy,
  CONTENT_SECURITY_POLICY_HEADER,
  missingSecurityHeaders,
  STATIC_SECURITY_HEADERS,
} from "@perry-starter/env/security-headers";
import { expect, test } from "vitest";

import { withSecurityHeaders } from "../security-headers";

type Branch = "error" | "redirect" | "success";

// A DELIBERATELY BROKEN variant of the real wrapper: it applies the full set
// EXCEPT it omits `dropHeader` when the response lands on `dropBranch` — modeling
// a regression that forgets one header on exactly one branch.
const withDroppedHeaderOnBranch = async (
  produce: () => Promise<Response>,
  dropBranch: Branch,
  dropHeader: string
): Promise<Response> => {
  let res: Response;
  let branch: Branch;
  try {
    res = await produce();
    branch = res.status >= 300 && res.status < 400 ? "redirect" : "success";
  } catch {
    res = new Response("{}", { status: 500 });
    branch = "error";
  }
  const headers = new Headers(res.headers);
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    if (branch === dropBranch && name === dropHeader) {
      continue;
    }
    headers.set(name, value);
  }
  if (
    !(branch === dropBranch && dropHeader === CONTENT_SECURITY_POLICY_HEADER)
  ) {
    headers.set(
      CONTENT_SECURITY_POLICY_HEADER,
      buildContentSecurityPolicy({ nonce: "twinnonce" })
    );
  }
  return new Response(res.body, { status: res.status, headers });
};

const succeed = (status: number, init?: ResponseInit) => () =>
  Promise.resolve(new Response("ok", { status, ...init }));
const reject = () => Promise.reject(new Error("boom"));

test("dropping a header on the SUCCESS branch reddens the gate predicate", async () => {
  const res = await withDroppedHeaderOnBranch(
    succeed(200),
    "success",
    "X-Frame-Options"
  );
  expect(missingSecurityHeaders(res.headers)).toContain("X-Frame-Options");
});

test("dropping a header on the ERROR branch reddens the gate predicate", async () => {
  const res = await withDroppedHeaderOnBranch(
    reject,
    "error",
    "Strict-Transport-Security"
  );
  expect(missingSecurityHeaders(res.headers)).toContain(
    "Strict-Transport-Security"
  );
});

test("dropping the CSP on the REDIRECT branch reddens the gate predicate", async () => {
  const res = await withDroppedHeaderOnBranch(
    succeed(302, { headers: { location: "/x" } }),
    "redirect",
    CONTENT_SECURITY_POLICY_HEADER
  );
  expect(missingSecurityHeaders(res.headers)).toContain(
    CONTENT_SECURITY_POLICY_HEADER
  );
});

test("a drop confined to ONE branch leaves the OTHER branches green (branch-specific)", async () => {
  // The break is scoped to the error branch; the success leg must stay clean.
  const clean = await withDroppedHeaderOnBranch(
    succeed(200),
    "error",
    "X-Frame-Options"
  );
  expect(missingSecurityHeaders(clean.headers)).toEqual([]);
});

test("the good baseline stays green — the REAL wrapper drops nothing on any branch", async () => {
  const ok = await withSecurityHeaders(succeed(200));
  const err = await withSecurityHeaders(reject);
  const redirect = await withSecurityHeaders(
    succeed(302, { headers: { location: "/x" } })
  );
  expect(missingSecurityHeaders(ok.headers)).toEqual([]);
  expect(missingSecurityHeaders(err.headers)).toEqual([]);
  expect(missingSecurityHeaders(redirect.headers)).toEqual([]);
});
