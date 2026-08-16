---
name: stripe-replit-sync must stay external to esbuild
description: Bundling stripe-replit-sync silently skips its schema migrations
---
**Rule:** `stripe-replit-sync` must be listed in the api-server esbuild `external` array.

**Why:** its `runMigrations` resolves SQL files via `path.resolve(__dirname, "./migrations")`. When bundled, `__dirname` points at the app's `dist/`, the directory doesn't exist, and `connectAndMigrate` logs "not found, skipping" (invisible unless a logger is passed) and returns success. Result: `stripe` schema exists but is empty, and every later sync call fails with `relation "stripe.accounts" does not exist`.

**How to apply:** any package that reads sibling data files by `__dirname` needs externalizing (or its assets copied into dist). If the `stripe` schema is present but empty, suspect this before suspecting credentials.
