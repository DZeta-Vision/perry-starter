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
