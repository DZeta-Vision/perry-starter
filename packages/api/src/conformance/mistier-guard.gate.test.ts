// Mis-tier build guard — the admin surface cannot serve its data through an
// auth-only (non-role-gated) procedure.
//
// This is a build-time STRUCTURAL guard (it runs in the blocking `node`
// conformance suite; no app boot, pure static analysis + router introspection).
// It asserts two things about the SHIPPED artifacts:
//   1. the procedure-tier manifest classifies EXACTLY the router's real procedure
//      paths — no untagged procedure (which the guard treats as auth = a
//      violation for an admin page) and no stale entry, so the manifest cannot
//      silently drift from the router, and
//   2. every admin page (a route whose `createFileRoute("/admin…")`) reads its
//      admin data ONLY through an admin-tier (role-gated) procedure.
//
// The mutation twin (mistier-guard.mutation.test.ts) drives the SAME guard against
// a synthetic admin page that fetches admin data through the auth-only tier and
// asserts it goes RED — proving the guard is anti-vacuous.

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AdminPageSource,
  appRouterProcedurePaths,
  findMisTierAdminDataViolations,
  PROCEDURE_TIERS,
  referencedProcedures,
} from "@perry-starter/api/procedure-tiers";
import { expect, test } from "vitest";

const ROUTES_DIR = join(process.cwd(), "apps", "web", "src", "routes");
const ADMIN_ROUTE_RE = /createFileRoute\(\s*["']\/admin/;
const TSX_FILE_RE = /\.tsx?$/;

// Discover the admin pages by their route path (not merely their filename), so a
// new admin route under any name is covered.
const collectAdminPages = (dir: string, out: AdminPageSource[]): void => {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectAdminPages(full, out);
    } else if (entry.isFile() && TSX_FILE_RE.test(entry.name)) {
      const text = readFileSync(full, "utf8");
      if (ADMIN_ROUTE_RE.test(text)) {
        out.push({ path: full, text });
      }
    }
  }
};

const adminPages = (): AdminPageSource[] => {
  const out: AdminPageSource[] = [];
  collectAdminPages(ROUTES_DIR, out);
  return out;
};

test("the procedure-tier manifest classifies exactly the router's real procedure paths", () => {
  const manifestPaths = [...Object.keys(PROCEDURE_TIERS)].sort();
  const routerPaths = [...appRouterProcedurePaths()].sort();
  // No untagged procedure and no stale manifest entry — the guard has full,
  // current knowledge of every procedure's tier.
  expect(manifestPaths).toEqual(routerPaths);
});

test("at least one admin page exists and it fetches admin data through the admin tier (non-vacuous)", () => {
  const pages = adminPages();
  expect(pages.length).toBeGreaterThan(0);
  const referenced = pages.flatMap((page) => [
    ...referencedProcedures(page.text),
  ]);
  // The guard has a real admin-tier data read to protect.
  expect(referenced).toContain("admin.summary");
});

test("no shipped admin page reads admin data through an auth-only procedure", () => {
  expect(findMisTierAdminDataViolations(adminPages())).toEqual([]);
});
