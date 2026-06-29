---
name: run-app
description: Launch and drive this app locally — the web dev server (browser UI over loopback) and the headless daemon target. Use when asked to run, start, serve, or screenshot the app, or to confirm a change works in the real running app.
---

# Running the app locally

The product is **local-first with a cross-target build seam** (`PERRY_TARGET`). There are two ways to "run the app"; pick by what you're verifying.

## Path A — web dev server (fastest; what you usually want)

Serves the React UI with SSR. Note: in dev the SSR runs inside a Cloudflare `workerd` runtime (via the `alchemy` Vite plugin), so the server env comes from the **alchemy/wrangler config, not `apps/web/.env`** (the dotenv file only feeds the Node/Vite process).

**One-time setup (fresh clone):**
1. `bun install`
2. Create `apps/web/.env` with the full server env contract (gitignored). Required keys: `PERRY_TARGET` (`local-sidecar` | `cloud-relay`), `VITE_PERRY_TARGET`, `SURREAL_URL`, `SURREAL_NS`, `SURREAL_DB`, `SURREAL_USER`, `SURREAL_PASS`, `BETTER_AUTH_SECRET` (≥32 chars), `BETTER_AUTH_URL`, `CORS_ORIGIN`. For a quick local run these can be placeholders (e.g. `PERRY_TARGET=local-sidecar`, `SURREAL_URL=http://127.0.0.1:8000`, ns/db/user/pass = `perry`/`perry`/`root`/`root`, the auth URLs = `http://localhost:3000`).
3. From `packages/infra`: `alchemy configure` (one-time Cloudflare OAuth) then `alchemy dev` — this generates `apps/web/.alchemy/local/wrangler.jsonc`. `alchemy.run.ts` binds the full env contract into the worker, so the generated config is complete (an incomplete `vars` block makes the SSR worker 500 with "Invalid environment variables").

**Run:** `bun dev:web` → open the printed `http://localhost:<port>/` (it auto-increments if 3000/3001/3002 are taken — read the log line `➜ Local: …`).

**Drive it:** `curl` only returns the SSR shell — route content (e.g. `/login`) is client-rendered and hydrates in the browser, so render-time errors only show in a real browser or a jsdom render test. To verify a route component without a browser, add a `@testing-library/react` render test under the `web` vitest project (`bunx vitest run --project web …`).

**Smoke:** `curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:<port>/` should be `200`. Tail the dev-server log for `Invalid environment variables` (missing worker env) or component throws.

## Path B — headless daemon (the local-sidecar product shape)

The shipped product is a single PerryTS daemon (`apps/daemon`) that supervises a `surreal` sidecar and serves the built SPA same-origin over `http://127.0.0.1`. This needs `perry compile apps/daemon/src/main.ts` + the SPA build (`PERRY_TARGET=local-sidecar` with `spa.enabled`). This compiled-boot-over-loopback path is **not yet validated end-to-end** (operator drill) — prefer Path A unless you are specifically testing the daemon.

## Prerequisites
- `bun` (package manager + runner), `surreal` 3.1.5 (data sidecar), and for Path B `perry`.
- Path A needs a Cloudflare account for the one-time `alchemy configure` (the dev SSR runs in `workerd`).

## Gotchas
- **Port drift:** another local project may hold 3000/3001 — always read the actual port from the `bun dev:web` log.
- **Worker env ≠ `.env`:** the dev SSR worker reads `apps/web/.alchemy/local/wrangler.jsonc` vars (sourced from `alchemy.run.ts` bindings), not the dotenv file.
- **`/login` is client-rendered:** a component crash there appears only after hydration in the browser; guard with a render test.
