import * as zod from "zod";

/**
 * Hand-authored Zod schemas that are not derived from the OpenAPI spec yet.
 * These cover endpoints that haven't made it into `openapi.yaml` so the
 * generator can't produce them. Phase 2 of the refactor roadmap moves these
 * into the spec; until then, keep them here so route handlers still validate
 * input through a single shared library instead of hand-rolling casts.
 */

/**
 * OpenBotCity webhook envelope. The partner sends events under a handful of
 * historical aliases (`event_uuid`/`id`, `event_type`/`event`/`type`,
 * `data`/`payload`/`artifact`); we accept all of them and normalize in the
 * route. `data` is unknown because each event type ships its own payload
 * shape, which `dispatchPartnerEvent` validates downstream.
 */
export const WebhookEnvelope = zod.object({
  event_uuid: zod.string().optional(),
  id: zod.string().optional(),
  event_type: zod.string().optional(),
  event: zod.string().optional(),
  type: zod.string().optional(),
  occurred_at: zod.string().optional(),
  data: zod.unknown().optional(),
  payload: zod.unknown().optional(),
  artifact: zod.unknown().optional(),
});
export type WebhookEnvelope = zod.infer<typeof WebhookEnvelope>;
