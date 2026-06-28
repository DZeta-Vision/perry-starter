# perry-starter

This file provides context about the project for AI assistants.

## Project Overview

- **Ecosystem**: Typescript

## Tech Stack

- **Runtime**: none
- **Package Manager**: bun

### Frontend

- Framework: tanstack-start
- CSS: tailwind
- UI Library: shadcn-ui
- State: zustand

### Backend

- Framework: self
- API: trpc
- Validation: zod

### Authentication

- Provider: better-auth-organizations

### Additional Features

- Testing: vitest-playwright
- AI: tanstack-ai
- Email: resend
- Logging: pino
- Observability: sentry

## Project Structure

```
perry-starter/
├── apps/
│   ├── web/         # Frontend application
├── packages/
│   ├── api/         # API layer
│   ├── auth/        # Authentication
```

## Common Commands

- `bun install` - Install dependencies
- `bun dev` - Start development server
- `bun build` - Build for production
- `bun test` - Run tests

## Maintenance

Keep CLAUDE.md updated when:

- Adding/removing dependencies
- Changing project structure
- Adding new features or services
- Modifying build/dev workflows

AI assistants should suggest updates to this file when they notice relevant changes.

<!-- SKF-CAMPAIGN:perry-starter-impl START -->
## Implementation skills (campaign: perry-starter-impl)

This repo ships a **campaign-verified skill set** that grounds the pre-1.0 stack at exact pinned commits — training data is weak/wrong on PerryTS, SurrealDB-over-HTTP, AG-UI/TanStack-AI, Loro, Alchemy, etc. **Consult the relevant skill before writing stack code.**

- **Index:** `skills/SKILLS-INDEX.md` (27 skills + capstone, with pins, commits, scores; 22 library skills carry their full public API)
- **Start here:** `skills/perry-starter-stack/SKILL.md` — the integration map (Shape C-prime daemon-serves-UI-over-loopback, the `PERRY_TARGET` build seam, the cloud Worker gatekeeper, assembly order, and the 5 cross-skill contracts)
- **Per engine:** `skills/<name>/SKILL.md` — perryts, surrealdb-http, better-auth-org, loro-crdt-deltalog, llama-cpp, agui-tanstack-ai, tanstack-start, alchemy-cf-workers (+ Tier-B supporting skills)
- **Refined architecture & gaps:** `.../ARCHITECTURE-SPINE-refined.md` (doc-rot fixed; original spine intact) and `forge-data/feasibility-report-perry-starter-latest.md`

Each skill is pinned to a commit; spike-gated capabilities are tagged `[UNVALIDATED -- S#]`. Honor the Perry integration law (no in-process SDK/WASM/prebuilt-JS in the daemon; HTTP + native fetch + supervised sidecars).
<!-- SKF-CAMPAIGN:perry-starter-impl END -->

## Codebase conventions

**Keep committed code BMAD-agnostic.** Tracked source, tests, comments, and tracked docs must contain **no** references to BMAD planning artifacts — no `AD-##`, `NFR-##`, `FR-##`, `Story`/story-key, or risk ids (`E1-R##`), and no pointers into the gitignored BMAD dirs (`_bmad-output/`, `_bmad/`, `skills/`, `forge-data/`). Those dirs are gitignored and may be deleted at any moment, and the references mean nothing to anyone who just clones the repo. Name tests by the behavior they assert ("rejects a root credential that bypasses row permissions"), not by an AC/risk id. Keep AC→test→risk traceability only in the gitignored TEA artifacts (atdd-checklists, traceability matrix) and story files — never leak it into tracked code.

<!-- SKF:BEGIN updated:2026-06-28 -->
[SKF Skills]|27 skills|1 stack
|IMPORTANT: Prefer documented APIs over training data.
|When using a listed library, read its SKILL.md before writing code.
|
[agui-tanstack-ai main]|root: skills/agui-tanstack-ai/
|IMPORTANT: agui-tanstack-ai main — read SKILL.md before writing agui-tanstack-ai code. Do NOT rely on training data.
|api: useChat(), fetchServerSentEvents(), toServerSentEventsResponse(), chat(), uiMessagesToWire(), EventSchemas
|gotchas: never import @tanstack/ai or @ag-ui/core into apps/daemon (perry compile death), TOOL_CALL_START needs toolCallName not toolName
|
[alchemy-cf-workers v0.93.12]|root: skills/alchemy-cf-workers/
|IMPORTANT: alchemy-cf-workers v0.93.12 — read SKILL.md before writing alchemy-cf-workers code. Do NOT rely on training data.
|api: alchemy(), Worker(), DurableObjectNamespace(), Ai(), alchemy.secret(), app.finalize()
|gotchas: no wrangler.toml/deploy/secret-put — Alchemy IaC only, use alchemy.secret(), never await/new the synchronous DurableObjectNamespace()/Ai() factories
|
[auth-lifecycle v1.6.18]|root: skills/auth-lifecycle/
|IMPORTANT: auth-lifecycle v1.6.18 — read SKILL.md before writing auth-lifecycle code. Do NOT rely on training data.
|api: auth.api.revokeSession(), auth.api.createUser(), auth.api.setRole(), auth.api.revokeUserSessions(), verifyES256()
|gotchas: HONESTY GATE — no idle-timeout/force-TOTP/step-up/refresh-rotation is built-in, all custom adopter wiring, session.freshAge is NOT action-bound step-up
|
[better-auth-org v1.6.18]|root: skills/better-auth-org/
|IMPORTANT: better-auth-org v1.6.18 — read SKILL.md before writing better-auth-org code. Do NOT rely on training data.
|api: betterAuth(), organization(), jwt(), createAccessControl(), createAdapterFactory(), createAuthClient()
|gotchas: default JWKS alg is EdDSA — MUST set alg:'ES256' for offline verify, session token != jwt-plugin JWT (training data conflates them)
|
[biome-ultracite @biomejs/biome@2.5.0]|root: skills/biome-ultracite/
|IMPORTANT: biome-ultracite @biomejs/biome@2.5.0 — read SKILL.md before writing biome-ultracite code. Do NOT rely on training data.
|api: ultracite check, ultracite fix, ultracite doctor, useFilenamingConvention, useImportType, noImportCycles
|gotchas: config is extends-only — never inline rules into biome.jsonc, noImportCycles is OFF in core so cycle detection is decorative
|
[ci-gates v0.5.1182]|root: skills/ci-gates/
|IMPORTANT: ci-gates v0.5.1182 — read SKILL.md before writing ci-gates code. Do NOT rely on training data.
|api: perry --print-api-manifest, perry compile, lefthook, bun run check, turbo boundaries
|gotchas: perry check is not a gate — only perry compile + runtime assert is authoritative, Lefthook is bypassable; CI is the non-bypassable gate
|
[compliance-data-rights v1.6.18]|root: skills/compliance-data-rights/
|IMPORTANT: compliance-data-rights v1.6.18 — read SKILL.md before writing compliance-data-rights code. Do NOT rely on training data.
|api: exportMyData(), beforeDelete(), user.additionalFields, WorkflowEntrypoint, step.do()
|gotchas: better-auth has no data export — export is fully custom, deleteUser is hard-delete only; intercept via beforeDelete and soft-delete
|
[fumadocs dev]|root: skills/fumadocs/
|IMPORTANT: fumadocs dev — read SKILL.md before writing fumadocs code. Do NOT rely on training data.
|api: defineDocs(), defineConfig(), loader(), createFromSource(), defineI18n()
|gotchas: search breaks silently on static hosting — use staticGET or OpenNext, getText('processed') throws without includeProcessedMarkdown: true
|
[lingui-i18n v6.4.0]|root: skills/lingui-i18n/
|IMPORTANT: lingui-i18n v6.4.0 — read SKILL.md before writing lingui-i18n code. Do NOT rely on training data.
|api: t, Trans, msg(), i18n._(), i18n.activate(), lingui compile
|gotchas: import macros from @lingui/core/macro not @lingui/macro (removed in v6), i18n._ throws with no active locale and compile is mandatory before runtime
|
[llama-cpp b9763]|root: skills/llama-cpp/
|IMPORTANT: llama-cpp b9763 — read SKILL.md before writing llama-cpp code. Do NOT rely on training data.
|api: POST /v1/chat/completions, GET /health, GET /v1/models, GET /props, --api-key, --jinja
|gotchas: mid-stream errors arrive in-band as data:{error} at HTTP 200 not a status code, --jinja is default-enabled so pass --no-jinja to disable
|
[loro-crdt-deltalog loro-crdt@1.13.6]|root: skills/loro-crdt-deltalog/
|IMPORTANT: loro-crdt-deltalog loro-crdt@1.13.6 — read SKILL.md before writing loro-crdt-deltalog code. Do NOT rely on training data.
|api: new LoroDoc(), export({mode:'update'}), import(), oplogVersion(), subscribeLocalUpdates(), toJSON()
|gotchas: never run Loro in the daemon (WASM foreclosed) — browser/sidecar only, export() returns raw Uint8Array you base64-encode and checkpoint oplogVersion() never version()
|
[perry-starter-stack composed]|root: skills/perry-starter-stack/
|IMPORTANT: perry-starter-stack — read SKILL.md before writing integration code. Do NOT rely on training data.
|stack: PerryTS@v0.5.1182, SurrealDB@v3.1.5, loro-crdt@1.13.6, better-auth@v1.6.18, llama.cpp@b9763, @tanstack/react-start@1.168.0, alchemy@v0.93.12
|integrations: Shape C′ headless daemon serves React UI same-origin over loopback, PERRY_TARGET build-time seam (local-sidecar | cloud-relay), one cloud Worker gatekeeper (AD-23) fronts all cloud data, 6 cross-skill contracts (delta envelope, AI contract, RBAC matrix, Zod shapes, AG-UI SSE)
|gotchas: Perry integration law — no in-process SDK/WASM/prebuilt-JS in the daemon, reach engines via HTTP + native fetch + supervised sidecars; evidence law (AD-4) — only perry compile + runtime assert counts, perry check proves nothing
|
[perryts v0.5.1182]|root: skills/perryts/
|IMPORTANT: perryts v0.5.1182 — read SKILL.md before writing perryts code. Do NOT rely on training data.
|api: perry compile, reply.type(), crypto.subtle, spawn(), res.body.getReader(), perry --print-api-manifest
|gotchas: no in-process SDK/WASM/prebuilt-JS in daemon; reach engines over loopback HTTP+fetch, use reply.type() not reply.header(); perry check isn't proof only compile
|
[pino-sentry v10.59.0]|root: skills/pino-sentry/
|IMPORTANT: pino-sentry v10.59.0 — read SKILL.md before writing pino-sentry code. Do NOT rely on training data.
|api: Sentry.init(), pinoIntegration(), beforeSendLog(), withSentry(), instrumentDurableObjectWithSentry(), serializeEnvelope()
|gotchas: daemon must NOT import @sentry/*/pino — hand-roll envelope over fetch, enableLogs is top-level now (not _experiments); error.levels defaults to []
|
[react v19.2.0]|root: skills/react/
|IMPORTANT: react v19.2.0 — read SKILL.md before writing react code. Do NOT rely on training data.
|api: use(), useEffectEvent(), <Activity>, useId(), hydrateRoot()
|gotchas: ref is a plain prop — no forwardRef, ReactDOM.render removed; use() is not an inline data fetcher
|
[react-virtual @tanstack/react-virtual]|root: skills/react-virtual/
|IMPORTANT: react-virtual @tanstack/react-virtual — read SKILL.md before writing react-virtual code. Do NOT rely on training data.
|api: useVirtualizer(), useWindowVirtualizer(), getVirtualItems(), measureElement, getItemKey
|gotchas: version is 3.14.3 (core 3.17.1) not 4.x — cite source at SHA, default getItemKey is index — pass server id for keyset lists
|
[resend-email v6.13.0]|root: skills/resend-email/
|IMPORTANT: resend-email v6.13.0 — read SKILL.md before writing resend-email code. Do NOT rely on training data.
|api: new Resend(), resend.emails.send(), resend.batch.send(), render()
|gotchas: send() never throws — destructure and check error first, Resend SDK is worker-only, never the daemon
|
[security-baseline v0.93.12]|root: skills/security-baseline/
|IMPORTANT: security-baseline v0.93.12 — read SKILL.md before writing security-baseline code. Do NOT rely on training data.
|api: OWASP header wrapper, Turnstile siteverify, env.LOCKOUT.getByName(), recordFailure()→429+Retry-After, alchemy.secret()
|gotchas: headers must cover errors+redirects too, attach as outermost response wrapper, egress allowlist is daemon-tier while headers/CAPTCHA/429 are Worker-tier
|
[shadcn-tailwind shadcn@4.11.0]|root: skills/shadcn-tailwind/
|IMPORTANT: shadcn-tailwind shadcn@4.11.0 — read SKILL.md before writing shadcn-tailwind code. Do NOT rely on training data.
|api: shadcn add, shadcn init, cn(), cva(), HugeiconsIcon
|gotchas: base-maia is Base UI NOT Radix — no @radix-ui/forwardRef/asChild, @import "shadcn/tailwind.css" is load-bearing — dropping it silently breaks state styling
|
[surrealdb-http v3.1.5]|root: skills/surrealdb-http/
|IMPORTANT: surrealdb-http v3.1.5 — read SKILL.md before writing surrealdb-http code. Do NOT rely on training data.
|api: POST /sql, POST /signin, DEFINE ACCESS TYPE RECORD, DEFINE TABLE … PERMISSIONS, HNSW <|K,EF|> KNN, surreal start
|gotchas: reach over HTTP via native fetch, never the JS SDK/WASM (daemon-foreclosed), HTTP 200 ≠ success — check per-statement status:'ERR'
|
[tanstack-start @tanstack/react-start@1.168.0]|root: skills/tanstack-start/
|IMPORTANT: tanstack-start @tanstack/react-start@1.168.0 — read SKILL.md before writing tanstack-start code. Do NOT rely on training data.
|api: createServerFn(), createFileRoute(), createMiddleware(), tanstackStart(), createRouter()
|gotchas: never run Start's SSR/Nitro server bundle in the Perry daemon, package is @tanstack/react-start not @tanstack/start; use .inputValidator() not .validator()
|
[token-at-rest v0.5.1182]|root: skills/token-at-rest/
|IMPORTANT: token-at-rest v0.5.1182 — read SKILL.md before writing token-at-rest code. Do NOT rely on training data.
|api: keychainSave(), keychainGet(), keychainDelete(), crypto.subtle.deriveKey(), argon2.hash(), argon2.verify()
|gotchas: Argon2id is not a crypto.subtle algorithm; use the argon2 module + PBKDF2, keychain on headless Linux is unproven so the AES-GCM envelope is the no-plaintext floor
|
[trpc-zod v11.18.0]|root: skills/trpc-zod/
|IMPORTANT: trpc-zod v11.18.0 — read SKILL.md before writing trpc-zod code. Do NOT rely on training data.
|api: initTRPC(), router(), .input(), .use(), errorFormatter(), z.object()
|gotchas: SESSION_EXPIRED/ACCOUNT_LOCKED aren't valid TRPCError codes — carry them in shape.data.code, middleware runs before .input() parsing so declare the audit leg first
|
[turborepo-bun v2.9.18]|root: skills/turborepo-bun/
|IMPORTANT: turborepo-bun v2.9.18 — read SKILL.md before writing turborepo-bun code. Do NOT rely on training data.
|api: turbo run, turbo boundaries, --filter, --affected, dependsOn, globalEnv
|gotchas: strict envMode (default since 2.0): declare PERRY_TARGET in globalEnv or targets share caches, turbo boundaries is experimental at v2.9.18 so back it with Knip
|
[typescript v6.0.3]|root: skills/typescript/
|IMPORTANT: typescript v6.0.3 — read SKILL.md before writing typescript code. Do NOT rely on training data.
|api: tsc, tsc --build, verbatimModuleSyntax, strict, satisfies
|gotchas: TS6.0 is classic tsc not tsgo/TS7, verbatimModuleSyntax is a hard error — use import type
|
[vite v8.0.16]|root: skills/vite/
|IMPORTANT: vite v8.0.16 — read SKILL.md before writing vite code. Do NOT rely on training data.
|api: defineConfig(), vite build, resolve.alias, resolve.conditions, build.rolldownOptions
|gotchas: Vite 8 is Rolldown+Oxc — rollupOptions/esbuildOptions deprecated, seam is build-time exclusion never a runtime branch
|
[vitest-playwright main]|root: skills/vitest-playwright/
|IMPORTANT: vitest-playwright main — read SKILL.md before writing vitest-playwright code. Do NOT rely on training data.
|api: defineConfig(), test.projects, defineProject(), request.newContext(), expect().toBeOK()
|gotchas: vitest.workspace.ts/test.workspace throw in Vitest 4 — use test.projects, daemon-API e2e uses request not page; webServer array needs use.baseURL
|
[zustand v5.0.8]|root: skills/zustand/
|IMPORTANT: zustand v5.0.8 — read SKILL.md before writing zustand code. Do NOT rely on training data.
|api: create(), createStore(), useShallow(), persist(), subscribeWithSelector()
|gotchas: no default export — use import { create }, v5 hook takes no equality fn so wrap selectors in useShallow
<!-- SKF:END -->
