---
name: Production data writes & legacy-account consolidation
description: How to mutate production data in KAX given the agent's prod DB is read-only, and the legacy→wallet account ownership-transfer mechanism.
---

# Production data writes must go through deployed app code

The agent can only run **read-only** SELECTs against the production DB
(`executeSql environment:"production"`). It cannot UPDATE/INSERT/DELETE prod, and
must not write custom prod migration scripts.

**To change production *data*, write app code that performs the change, gate it,
deploy it.** The codebase's established pattern is an idempotent **startup step**
(`warmUpInBackground` → `runStartupStep(...)` in api-server `index.ts`) that runs
once per boot; deploying triggers it. Startup steps are failure-isolated (logged,
non-fatal) so a data-fix can't brick boot.

**Why:** prod schema/data is managed by Replit's publish flow + the running app,
not by the agent. A one-shot, env-gated, idempotent startup step is the safe lever.

**How to apply:** gate on env vars so it only fires for the intended target; wrap
multi-table changes in a single `db.transaction`; make every write
`WHERE col = <source>` so reruns match zero rows once drained (idempotent); verify
afterward with read-only prod SELECTs of per-table counts.

# Legacy (email) → wallet account consolidation

KAX login is wallet-only. Accounts onboarded before that (email/OIDC era) have no
`wallet_address` and become un-loginable, stranding everything they own
(`owner_id`). Consolidation = transfer ownership to the user's current wallet
account, not re-enable the old login.

Owner-scoped columns to move (grep `owner_id|user_id|sent_by_user_id` in
`lib/db/src/schema`): `agents`, `artifacts`, `drops`, `activities`, and the
partner-events tables `proposals/dms/matches/outbound_messages` (+
`outbound_messages.sent_by_user_id`, `user_bots.user_id`). Also promote the
destination user to `admin` if the legacy account was admin.

Mechanism: `claimLegacyOwnership()` in api-server `lib/backfill.ts`, gated by
`KAX_CLAIM_FROM_USER_ID` + `KAX_CLAIM_TO_WALLET`. **The destination wallet user
must already exist** (they have to have signed in with that wallet once) — the
step warns and skips if not. After a confirmed prod run, clearing the two env
vars removes any future misconfiguration risk (the step is idempotent, so leaving
them is also safe).
