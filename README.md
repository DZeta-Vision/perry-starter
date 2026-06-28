# perry-starter

This project was created with [Better Fullstack](https://github.com/Marve10s/Better-Fullstack), a modern TypeScript stack that combines React, TanStack Start, Self, TRPC, and more.

## Features

- **TypeScript** - For type safety and improved developer experience
- **TanStack Start** - SSR framework with TanStack Router
- **TailwindCSS** - CSS framework
- **shadcn/ui** - UI components
- **tRPC** - End-to-end type-safe APIs
- **Authentication** - better-auth-organizations
- **TanStack DB** - Reactive client-first data store
- **TanStack Pacer** - Debounce, throttle & rate-limit utilities
- **TanStack Table** - Headless table with sorting, filtering & pagination
- **TanStack Virtual** - Virtualized lists & grids for 60fps performance
- **Turborepo** - Optimized monorepo build system

## Getting Started

First, install the dependencies:

```bash
bun install
```

Then, run the development server:

```bash
bun run dev
```

Open [http://localhost:3001](http://localhost:3001) in your browser to see the fullstack application.

## First run: `perry rename <domain>`

This is a clone-and-rename template. After cloning, make it yours in one step —
first-run is assembly, not a manual rename checklist:

```bash
bun run rename <domain>
```

For example, `bun run rename acme` rewrites the `perry-starter` identifier
family to your domain across the whole tree: the `@perry-starter/*` package
scope (every `package.json` name, workspace dependency, and `tsconfig` path),
the root workspace identity, the deploy base identifier (the Alchemy app id and
the Worker/DO base from which the per-environment namespaces derive), and the
generic `document`/`documents` reference-entity noun at every layer. It is a
thin, dependency-free identifier rewrite over the existing tree — it is
convergent and idempotent (running it a second time is a no-op), and it does
**not** scaffold or generate a project (the heavyweight CLI generator /
better-t-stack preset is intentionally out of v1).

> **Note:** the PerryTS `perry` CLI has a fixed subcommand set with no `rename`
> subcommand and no plugin hook, so the adopter-facing `perry rename <domain>`
> step is delivered as this repo script, invoked as `bun run rename <domain>`.
> It is deliberately not exposed as a `perry`-named binary (which would collide
> with the global PerryTS `perry` on `PATH`).

After renaming, `bun install` resolves the rewritten `@<domain>/*` workspace
graph and `bun dev` boots the renamed app-shell over loopback.

## Removing the reference entity

The repo ships a generic `documents` reference entity (a domain-neutral example
exercised by the rest of the template). It is removable-by-construction in one
documented step:

```bash
bun run remove-reference
```

This removes the `documents` entity end to end — the SurrealQL `documents` /
`document_delta` tables (the credential / access perimeter is preserved), the
`@<domain>/db` `documents` export and its module, the collaboration-mode
registry entry, the data-store implementations, and the daemon reference read
route and its wiring — leaving no domain coupling and no dangling module behind.

## Deployment (Cloudflare via Alchemy)

- Dev: cd apps/web && bun run alchemy dev
- Deploy: cd apps/web && bun run deploy
- Destroy: cd apps/web && bun run destroy

For more details, see the guide on [Deploying to Cloudflare with Alchemy](https://better-fullstack-web.vercel.app/docs/guides/cloudflare-alchemy).

## Project Structure

```
perry-starter/
├── apps/
│   └── web/         # Fullstack application (React + TanStack Start)
├── packages/
│   ├── api/         # API layer / business logic
│   ├── auth/        # Authentication configuration & logic
│   └── db/          # Database schema & queries
```

## Available Scripts

- `bun run dev`: Start all applications in development mode
- `bun run build`: Build all applications
- `bun run check-types`: Check TypeScript types across all apps
