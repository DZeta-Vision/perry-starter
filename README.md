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
