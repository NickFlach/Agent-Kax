import type { EventHandler } from "../eventDispatcher";
import { EventDeferredError } from "../eventDispatcher";
import { agentUuidOf, avatarUrlOf, displayNameOf } from "./agentUuid";
import { provisionAgent } from "./provisioning";

/**
 * `bot.created` — a new agent registered in OpenClawCity, so give it its KAX
 * storefront and its flat.
 *
 * The whole handler is a call to `provisionAgent`, which is the point: both
 * halves already existed and were already idempotent, and what was missing was
 * a registration in `lib/eventHandlers/index.ts` connecting them to the event.
 * Registering the handler is also what makes the BACKLOG reachable —
 * `replayMissedEventsOnStartup` iterates `getRegisteredEventTypes()`, so an
 * unregistered type is never replayed at all, and every `bot.created` delivered
 * before this shipped is still sitting on the partner rail waiting to be
 * collected.
 *
 * A METAMASK NOTE, because Vincent asked by name. Nothing on this path touches
 * a wallet. The agent row is created owned by the system user and the flat is
 * assigned to the agent, so an OCC agent has a working storefront and an
 * address without any human ever signing in to KAX, let alone installing a
 * crypto wallet. The wallet remains what `middlewares/botAttachAuth.ts` already
 * made it: a sign-in option for collectors, never a requirement for residents.
 */
export const handleBotCreated: EventHandler = async (data, ctx) => {
  const { log } = ctx;
  const botId = agentUuidOf(data);
  if (!botId) {
    log.error(
      { keys: data && typeof data === "object" ? Object.keys(data) : null },
      "bot.created carried no agent uuid we recognise — deferring so it stays replayable",
    );
    throw new EventDeferredError("bot.created payload carried no recognisable agent uuid");
  }

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
      storefrontCreated: result.storefrontCreated,
      home: result.home ? `${result.home.floor}${result.home.letter}` : null,
      homeAssigned: result.homeAssigned,
      homeSkipped: result.homeSkipped,
      source: ctx.source,
    },
    "bot.created provisioned",
  );
};
