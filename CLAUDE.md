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
