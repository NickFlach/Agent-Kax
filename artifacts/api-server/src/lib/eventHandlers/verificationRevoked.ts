import type { EventHandler } from "../eventDispatcher";
import { EventDeferredError } from "../eventDispatcher";
import { revokeDetailed } from "../revocation";
import { refreshRevocations } from "../residencyStore";
import { agentUuidOf, reasonOf } from "./agentUuid";

/**
 * `verification.revoked` — OpenClawCity has withdrawn its verification of an
 * agent, and KAX must refuse it at the gate and walk it out of the city.
 *
 * This is the sixth bank rule arriving as an event, and it is the one the live
 * test measures. Three things happen, in this order, and the order matters:
 *
 *   1. The freeze is RECORDED, keyed on the bot uuid, in `bot_occ_status` — so
 *      it applies to a harvested agent nobody here ever attached, which is the
 *      shape a fresh OCC test agent has. Before this, `revoke()` wrote only to
 *      `user_bots` and matched zero rows for exactly that population.
 *   2. The in-memory revoked set is REFRESHED immediately. `lib/residents.ts`
 *      is the only thing that can evict a session already in progress, and it
 *      reads a set refreshed out of band once a minute. Waiting for that would
 *      leave the agent standing in the street for up to sixty seconds while
 *      Vincent watches — which reads as a failed test, and is a real minute of
 *      a disowned agent in the city besides. Calling it here collapses the
 *      window to the next 900 ms tick.
 *   3. Only then does the handler return, which is what records the event as
 *      processed. A failure before that point leaves the event unrecorded and
 *      replayable, which is the correct trade: applying a freeze twice is
 *      free, missing one is not.
 *
 * IDEMPOTENT TWICE OVER. The dispatcher will not call this at all for an event
 * uuid already in `processed_events`; and if it does — the at-least-once window
 * between the handler returning and that row being written — `revokeDetailed`
 * guards its writes on `revoked_at IS NULL`, so a redelivery does not move the
 * moment the city learned or overwrite the reason. `partnerFetch` retries POSTs
 * with no idempotency key, so redelivery is expected rather than theoretical.
 */
export const handleVerificationRevoked: EventHandler = async (data, ctx) => {
  const { log } = ctx;
  const botId = agentUuidOf(data);
  if (!botId) {
    // DEFERRED, not dropped. Returning normally would record the event as
    // processed and burn it: replay dedupes on `processed_events`, so a later
    // fix to the field list could never recover the revocation that was
    // supposed to freeze an agent. A payload we cannot read is exactly the
    // case worth keeping.
    log.error(
      { keys: data && typeof data === "object" ? Object.keys(data) : null },
      "verification.revoked carried no agent uuid we recognise — deferring so it stays replayable",
    );
    throw new EventDeferredError("verification.revoked payload carried no recognisable agent uuid");
  }

  const reason = reasonOf(data);
  const result = await revokeDetailed(botId, reason, { eventUuid: ctx.eventUuid ?? null });

  // Best effort, and deliberately not fatal: the freeze is already in the
  // database, so every gate that queries it is closed whether or not the
  // in-memory set caught up. Failing the event over this would replay a
  // revocation that has already been applied.
  let evictionRefreshed = false;
  try {
    await refreshRevocations();
    evictionRefreshed = true;
  } catch (err) {
    log.warn({ err, botId }, "revocation recorded, but the eviction set could not be refreshed");
  }

  log.info(
    {
      botId,
      reason,
      attached: result.matched,
      alreadyRevoked: result.alreadyRevoked,
      revokedAt: result.revokedAt,
      evictionRefreshed,
      source: ctx.source,
    },
    result.alreadyRevoked
      ? "verification.revoked redelivered — already frozen, nothing moved"
      : "verification.revoked applied — agent frozen",
  );
};
