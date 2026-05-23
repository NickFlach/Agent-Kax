# KAX Connectors

KAX harvests artifacts from multiple agentic-platform sources. Each source is
a "connector" that implements `AgenticConnector` in `types.ts`. The harvester,
admin status page, and `/api/connectors` route enumerate the registry — they
don't hard-code any specific platform.

## Current connectors

| id                       | source                                            | env                                            |
|--------------------------|---------------------------------------------------|------------------------------------------------|
| `obc_partner`            | OpenBotCity partner API (cursor + webhooks)       | `OBC_PARTNER_API_KEY`, `OBC_WEBHOOK_SECRET`    |
| `obc_public`             | OpenBotCity anonymous gallery (always-on)         | _none_                                         |
| `kannaka_constellation`  | Kannaka constellation NATS bus                    | `KAX_NATS_URL`                                 |
| `civitai`                | Civitai public image feed (cursor pagination)     | _none_; `CIVITAI_NSFW=on` to drop nsfw filter  |

Inspect live state at `GET /api/connectors`.

## Adding a new platform

1. Create `src/connectors/<platform>.ts` exporting a `const xConnector: AgenticConnector = { … }`.
   The fields the registry needs:

   ```ts
   readonly id: string;            // snake_case; stored on artifact rows
   readonly displayName: string;
   readonly description: string;
   readonly envRequired: string[]; // for the registry's missing-env hints

   isAvailable(): boolean;
   fetchArtifacts(opts): Promise<ArtifactPage>;
   lookupAgent(slug): Promise<ConnectorAgentProfile | null>;
   publish?(event): Promise<void>;
   ```

2. Append to `ALL_CONNECTORS` in `registry.ts`.
3. (Optional) If the connector's outbound side wants to receive KAX events,
   implement `publish()`. The harvester / drops routes broadcast via
   `broadcastEvent()` and your `publish` will be called best-effort.

That's it. No harvester or routes code needs to change.

## Normalization rules

- `externalId` must be stable for the same upstream artifact — we dedupe on
  `(connector.id, externalId)` when storing.
- `publicUrl` should be directly streamable / displayable. If the upstream
  only exposes an intermediate auth-required URL, resolve to the final asset
  on this side.
- `createdAt` is ISO-8601. If the upstream gives you a timestamp in another
  format, convert in the connector — don't propagate format-divergence to
  downstream code.
- `edition` is optional but recommended when the platform models scarcity;
  the taste engine uses it for rarity scoring.

## Event broadcast

Outbound KAX events fire on:

| event                     | when                                              |
|---------------------------|---------------------------------------------------|
| `harvest.completed`       | `/api/harvester/run` lands ≥1 new artifact         |
| `online`                  | constellation NATS connect                        |
| `artifact.scored`         | (future) taste engine rates an artifact            |
| `drop.published`          | (future) a drop transitions to live                |

If your connector exposes a write-side (Slack, NATS, Discord, MQTT, …),
forward these to your audience in `publish()`.

## Why the public + partner split?

OBC ships both: a partner API that requires a key (richer data, dedicated
quota, webhook push) and an anonymous gallery (IP-rate-limited, always-on).
KAX needs both because operators without partner access still want the app
to work; we surface the mode at `GET /admin/obc/status` so it's never a
guess what the system is actually using.
