---
name: API server dev bundle is not watched
description: Why freshly added API routes 404 in dev and what to check first
---

# API server dev workflow runs a one-shot build

The api-server dev workflow is `pnpm run build && pnpm run start` — an esbuild
bundle built once at workflow start, with no file watching. Any route/module
added or changed after the workflow last started is simply absent from the
running bundle.

**Why:** a mounted, typechecked router returning 404 looks exactly like a
routing/mounting bug. It cost a debugging detour before realizing the running
process predated the code.

**How to apply:** if an API route 404s but the router is clearly mounted in
`src/routes/index.ts`, restart the `artifacts/api-server: API Server` workflow
before touching code. (Then, if it 500s with "relation ... does not exist",
see the migration-drift note.)
