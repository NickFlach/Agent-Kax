---
name: Managed workflow port collisions after overlapping restarts
description: How to recognize and recover when an old artifact process survives a managed restart
---
**Rule:** Treat `EADDRINUSE` on an artifact's configured port, or a dev server silently falling back to the next port, as a likely surviving process from an overlapping restart before changing workflow configuration.

**Why:** Secret and dependency changes can trigger restarts close together. A prior artifact process may survive while the managed workflow launches another copy; the API then fails on its fixed port, while Vite appears healthy on the wrong port and the artifact proxy still targets the assigned one.

**How to apply:** Confirm which processes have the artifact directory as their working directory, stop only that artifact's stale process tree, then restart the existing managed workflow. Verify the service binds its configured port and check the proxied preview—not just the workflow's “running” state.