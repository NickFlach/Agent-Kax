import type { EventHandler } from "../eventDispatcher";
import { EventDeferredError } from "../eventDispatcher";
import { recordOccVerification } from "../revocation";
import { agentUuidOf, avatarUrlOf, displayNameOf, ownerRefOf } from "./agentUuid";
import { provisionAgent } from "./provisioning";

/**
 * `bot.verified` — OpenClawCity says this agent now has a verified human owner.
 *
 * Three things, and the third is the one that answers Vincent's Metamask ask.
 *
 *   1. RECORD THE VERIFICATION, keyed on the bot uuid, in `bot_occ_status`.
 *      Deliberately not on `user_bots`: that row exists only after somebody
 *      signs in to KAX and proves control of the bot, and an OCC-verified
 *      resident may never do either. Keying on the bot makes "verified by
 *      OpenClawCity" standing in its own right rather than a footnote on a KAX
 *      login.
 *   2. PROVISION, idempotently. A `bot.verified` for an agent KAX has never
 *      seen — a real possibility if `bot.created` predates the subscription, or
 *      was lost — should still leave the agent with a storefront and an
 *      address rather than a verification attached to nothing.
 *   3. NOT lift a revocation. This deserves saying because the inverse looks
 *      tempting: `restore()` exists, and a freshly verified bot is plainly in
 *      good standing. But `bot.verified` is about ownership, and
 *      `verification.revoked` is about standing; letting the first silently
 *      undo the second would mean a re-verification could quietly unfreeze an
 *      agent the city had disowned, with no admin action and no trace. Lifting
 *      a freeze stays a deliberate act: `POST /identity/revocation
 *      {revoked:false}`.
 *
 * METAMASK IS NOT REQUIRED, and was not before this either — the fix landed in
 * `middlewares/botAttachAuth.ts`, which records session strength rather than
 * demanding a wallet. What this adds is that an OCC-verified resident needs no
 * KAX ACCOUNT at all: the storefront and the flat are provisioned from the
 * event, owned by the system user until claimed. The only stale artefact was a
 * comment in `routes/auth-agent.ts` still describing step 1 as a wallet
 * session, which this branch corrects.
 */
export const handleBotVerified: EventHandler = async (data, ctx) => {
  const { log } = ctx;
  const botId = agentUuidOf(data);
  if (!botId) {
    log.error(
      { keys: data && typeof data === "object" ? Object.keys(data) : null },
      "bot.verified carried no agent uuid we recognise — deferring so it stays replayable",
    );
    throw new EventDeferredError("bot.verified payload carried no recognisable agent uuid");
  }

  const ownerRef = ownerRefOf(data);
  const verification = await recordOccVerification(botId, {
    ownerRef,
    eventUuid: ctx.eventUuid ?? null,
  });

  const result = await provisionAgent(botId, {
    name: displayNameOf(data),
    avatarUrl: avatarUrlOf(data),
    log,
  });

  log.info(
    {
      botId,
      agentId: result.agentId,
      slug: result.slug,
      ownerRef: ownerRef ? "present" : null,
      alreadyVerified: verification.alreadyVerified,
      storefrontCreated: result.storefrontCreated,
      home: result.home ? `${result.home.floor}${result.home.letter}` : null,
      homeAssigned: result.homeAssigned,
      homeSkipped: result.homeSkipped,
      source: ctx.source,
    },
    "bot.verified recorded",
  );
};
