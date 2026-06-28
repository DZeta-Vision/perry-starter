// The daemon-consumed seam graph must bundle ONLY the selected target's impl: a
// runtime `if (target === …)` or a missing server-side resolution condition lets
// the cloud/WASM impl leak into the daemon graph (which would die at compile).
//
// Two legs, both deterministic (a per-target bundle + a static sentinel scan —
// no live services, no perry compile):
//   1. a two-target bundle matrix → the consumed graph for a target carries only
//      that target's `__IMPL__` sentinel ("local" | "cloud") and physically
//      excludes the other. The seam package is the graph the daemon consumes at
//      runtime; bundling it under each target's resolution condition is the
//      build-time exclusion the daemon relies on.
//   2. apps/web/vite.config.ts sets BOTH `resolve.conditions` (client) AND
//      `ssr.resolve.conditions` (server) so the SPA-shell prerender + cloud SSR
//      resolve the same impl as the client — never the default/wrong one.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

// Sentinel literals each seam impl exports (`documents.local.ts` → "local",
// `documents.cloud.ts` → "cloud").
const LOCAL_SENTINEL_RE =
  /__IMPL__[^\n]{0,32}["']local["']|["']perry-impl:local["']/;
const CLOUD_SENTINEL_RE =
  /__IMPL__[^\n]{0,32}["']cloud["']|["']perry-impl:cloud["']/;

// vite.config source guards: BOTH client and server resolution conditions.
const CLIENT_CONDITIONS_RE = /resolve\s*:\s*\{[\s\S]*?conditions/;
const SSR_CONDITIONS_RE =
  /ssr\s*:\s*\{[\s\S]*?resolve\s*:\s*\{[\s\S]*?conditions/;

const REPO_ROOT = resolve(process.cwd());
const WEB_DIR = join(REPO_ROOT, "apps", "web");
const VITE_CONFIG = join(WEB_DIR, "vite.config.ts");

// The per-target resolution condition the seam package's conditional exports map
// to *.local.ts / *.cloud.ts.
const PERRY_CONDITION: Record<"cloud-relay" | "local-sidecar", string> = {
  "cloud-relay": "perry-cloud",
  "local-sidecar": "perry-local",
};

// A minimal daemon-graph entry that consumes the seam package as a namespace, so
// the resolved impl module (and its sentinel) lands in the bundle.
const SEAM_PROBE_ENTRY = [
  'import * as seam from "@perry-starter/data";',
  "globalThis.__perryConsumedSeam = seam;",
].join("\n");

// Bundle the daemon-consumed seam graph for one PERRY_TARGET (resolved purely by
// the build-time condition) and return the emitted bundle text. The temp entry
// lives under the repo so the workspace package resolves; cleaned up after.
const buildForTarget = (target: "cloud-relay" | "local-sidecar"): string => {
  const work = mkdtempSync(join(REPO_ROOT, ".perry-bundle-"));
  try {
    const entry = join(work, "seam-graph.ts");
    const out = join(work, "seam-graph.bundle.js");
    writeFileSync(entry, SEAM_PROBE_ENTRY, "utf8");
    execFileSync(
      "bun",
      [
        "build",
        entry,
        "--conditions",
        PERRY_CONDITION[target],
        "--target",
        "node",
        "--outfile",
        out,
      ],
      { cwd: REPO_ROOT, stdio: "ignore" }
    );
    return readFileSync(out, "utf8");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

describe("the per-target build seam physically excludes the unselected impl", () => {
  test("the local-sidecar consumed graph carries only the local sentinel — the cloud impl is physically absent", () => {
    // Anti-vacuous: a both-impls bundle (runtime if / wrong condition) would
    // leak the cloud sentinel into the local graph.
    const localGraph = buildForTarget("local-sidecar");
    expect(localGraph).toMatch(LOCAL_SENTINEL_RE);
    expect(localGraph).not.toMatch(CLOUD_SENTINEL_RE);
  });

  test("the cloud-relay consumed graph carries only the cloud sentinel — the local impl is physically absent", () => {
    const cloudGraph = buildForTarget("cloud-relay");
    expect(cloudGraph).toMatch(CLOUD_SENTINEL_RE);
    expect(cloudGraph).not.toMatch(LOCAL_SENTINEL_RE);
  });

  test("apps/web/vite.config.ts sets BOTH resolve.conditions AND ssr.resolve.conditions — the server leg resolves the same impl as the client", () => {
    const config = readFileSync(VITE_CONFIG, "utf8");
    // Client resolution.
    expect(config).toMatch(CLIENT_CONDITIONS_RE);
    // Server resolution — without it the SPA-shell prerender + cloud SSR path
    // resolve the default/wrong impl server-side.
    expect(config).toMatch(SSR_CONDITIONS_RE);
  });
});
