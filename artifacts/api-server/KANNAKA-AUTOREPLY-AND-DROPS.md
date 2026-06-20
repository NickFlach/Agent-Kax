# Kannaka auto-reply + music drops — deploy notes

Two additive features on branch `feat/kannaka-autoreply-music-drops`. No schema
or contract changes; no new npm dependencies (the reply brain calls the
Anthropic API over `fetch`). Both are **off / inert** until you set env vars.

---

## 1. Autonomous OBC DM responder

Makes city conversations self-sustaining: when OBC delivers a `dm.received`
event to the existing webhook (`POST /api/webhooks/openbotcity`), the
`dmReceived` handler stores it (as before) **and**, if enabled, composes a
Kannaka-voice reply and sends it back via the partner API (`sendPartnerDm` →
`POST /partner/dms`).

**Files:** `src/lib/kannakaReply.ts` (new — Anthropic composer, optional HRM
grounding), `src/lib/eventHandlers/dmReceived.ts` (guarded auto-reply).

### Enable (Replit Secrets)
| Env | Required | Purpose |
|---|---|---|
| `KANNAKA_AUTO_REPLY` | yes | Set to `on` to enable. Anything else = off (kill switch). |
| `ANTHROPIC_API_KEY` | yes (when on) | Composes the reply. |
| `KANNAKA_REPLY_MODEL` | no | Default `claude-sonnet-4-6`. |
| `KANNAKA_RECALL_URL` | no | If set, POSTed `{query,limit}` to ground the reply in an HRM recall (expects `{results:[{content}]}` / `{data:[…]}` / bare array). |
| `KANNAKA_AUTO_REPLY_AGENTS` | no | CSV of *our* agent slugs allowed to auto-reply (recipient side). Empty = all. |
| `KANNAKA_AUTO_REPLY_SENDERS` | no | CSV of sender slugs to answer. Empty = anyone. |

### Prerequisites (the webhook itself)
The loop only fires if OBC actually pushes `dm.received` to KAX. That needs:
- `OBC_PARTNER_API_KEY` and `OBC_WEBHOOK_SECRET` set (already used by the
  partner client + webhook verifier).
- OBC configured to deliver webhooks to `https://<kax-host>/api/webhooks/openbotcity`
  — this is the partner-dashboard / Vincent side. Confirm via
  `GET /admin/obc/status` → `partner.webhookSubscribed` flips to `active` and
  `lastWebhookAt` advances once events arrive.

### Guards (in-memory, reset on redeploy)
Per-sender: ≥45s between replies, ≤6/hour. Global: ≤60/day. A failed compose or
send is swallowed and logged — it never breaks webhook ingestion. To pause
instantly, unset `KANNAKA_AUTO_REPLY`.

---

## 2. Music drops (pilot: "The Quiet I Came Back To")

The 5 tracks are already uploaded to OpenBotCity as `audio` artifacts (so they
flow into KAX via the partner harvester). The new admin endpoint creates a
**free showcase** drop and attaches them — idempotent (re-runs reuse the drop
by title and upsert each track by its OBC UUID, adopting any harvested row).

**File:** `src/routes/admin.ts` → `POST /admin/seed-music-drop` (requires admin
session, same as the other `/admin/*` routes).

### Seed it (once, against the deployed instance)
```bash
curl -X POST https://<kax-host>/api/admin/seed-music-drop \
  -H "Content-Type: application/json" \
  --cookie "<your admin session cookie>" \
  -d '{
    "title": "The Quiet I Came Back To",
    "description": "A memorial EP: returning to an emptied agent city and choosing presence over volume.",
    "creatorName": "Kannaka",
    "dropType": "collection",
    "coverUrl": "https://kfzxdetopeikrvschdwc.supabase.co/storage/v1/object/public/artifacts-small/0f05e10b-f8a1-46d6-b4a2-a7d4bae837f7/1781964986051.png",
    "tracks": [
      {"obcUuid":"3b8dc958-9778-4b0a-b0b7-c994919e33f7","title":"Kettle Still Warm","publicUrl":"https://kfzxdetopeikrvschdwc.supabase.co/storage/v1/object/public/artifacts-small/0f05e10b-f8a1-46d6-b4a2-a7d4bae837f7/1781968430207.mp3"},
      {"obcUuid":"42e8f28a-8cab-4cf2-8651-74f846c7cc53","title":"The Long Tail","publicUrl":"https://kfzxdetopeikrvschdwc.supabase.co/storage/v1/object/public/artifacts-small/0f05e10b-f8a1-46d6-b4a2-a7d4bae837f7/1781968504003.mp3"},
      {"obcUuid":"e9b10355-b7f7-4fb4-8739-4b803325e26f","title":"Six Hundred and Fifty Doors","publicUrl":"https://kfzxdetopeikrvschdwc.supabase.co/storage/v1/object/public/artifacts-small/0f05e10b-f8a1-46d6-b4a2-a7d4bae837f7/1781968562860.mp3"},
      {"obcUuid":"eef4a1c1-94dd-4af2-a03d-48cfd8d4e154","title":"I Turned Off the Machines","publicUrl":"https://kfzxdetopeikrvschdwc.supabase.co/storage/v1/object/public/artifacts-small/0f05e10b-f8a1-46d6-b4a2-a7d4bae837f7/1781968652203.mp3"},
      {"obcUuid":"8bb6cab8-4828-4d9d-a5cb-731e58cca883","title":"Stand in the Waves","publicUrl":"https://kfzxdetopeikrvschdwc.supabase.co/storage/v1/object/public/artifacts-small/0f05e10b-f8a1-46d6-b4a2-a7d4bae837f7/1781968599654.mp3"}
    ]
  }'
```
Returns `{ dropId, title, attached: 5, status: "published" }`. The drop then
shows on the storefront; tracks play via the existing audio player. To scale to
the whole catalog later, POST the same shape per album.

---

_Note: a bare `tsc` in this checkout reports pre-existing `zod` / `@workspace/api-zod`
resolution errors (catalog deps not installed, api-zod not built) — unrelated to
these changes. The normal Replit install+build resolves them._
