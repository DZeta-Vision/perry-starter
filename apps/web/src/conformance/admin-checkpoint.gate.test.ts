// The admin checkpoint is un-escapable by construction — every admin route routes
// its entry decision through the ONE shared server-side checkpoint. This scans the
// SHIPPED admin routes and asserts none escapes the checkpoint. The mutation twin
// drives the same guard against an admin route missing / inlining the checkpoint
// and asserts it reddens (anti-vacuous).

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  findUnguardedAdminRoutes,
  isAdminRoute,
  type RouteSource,
} from "./admin-route-guard";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = resolve(HERE, "..", "routes");
const TSX_FILE_RE = /\.tsx?$/;

const collectRoutes = (dir: string, out: RouteSource[]): void => {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRoutes(full, out);
    } else if (entry.isFile() && TSX_FILE_RE.test(entry.name)) {
      out.push({ path: full, text: readFileSync(full, "utf8") });
    }
  }
};

const routeSources = (): RouteSource[] => {
  const out: RouteSource[] = [];
  collectRoutes(ROUTES_DIR, out);
  return out;
};

test("at least one admin route ships (the guard is non-vacuous)", () => {
  const adminRoutes = routeSources().filter((source) =>
    isAdminRoute(source.text)
  );
  expect(adminRoutes.length).toBeGreaterThan(0);
});

test("every shipped admin route routes through the one shared checkpoint (no escape)", () => {
  expect(findUnguardedAdminRoutes(routeSources())).toEqual([]);
});
