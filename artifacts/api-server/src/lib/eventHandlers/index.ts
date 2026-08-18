import { registerEventHandler } from "../eventDispatcher";
import { handleArtifactCreated } from "./artifactCreated";
import { handleReactionReceived } from "./reactionReceived";
import { handleProposalCreated } from "./proposalCreated";
import { handleDmReceived } from "./dmReceived";
import { handleMatchCompleted } from "./matchCompleted";
import { handleVerificationRevoked } from "./verificationRevoked";
import { handleBotCreated } from "./botCreated";
import { handleBotVerified } from "./botVerified";

let registered = false;

/**
 * REGISTRATION IS WHAT UNLOCKS REPLAY, not just live delivery.
 *
 * `replayMissedEventsOnStartup()` iterates `getRegisteredEventTypes()`, so an
 * event type with no handler is never asked for at all. The three partner-status
 * types below have been arriving, authenticating and returning
 * `status: "unhandled"` — which was SAFE (an unhandled event is deliberately
 * left out of `processed_events`, and the webhook holds the cursor) but inert.
 * Adding them here is what makes the accumulated backlog collectable.
 */
export function registerAllEventHandlers(): void {
  if (registered) return;
  registered = true;
  registerEventHandler("artifact.created", handleArtifactCreated);
  registerEventHandler("reaction.received", handleReactionReceived);
  registerEventHandler("proposal.created", handleProposalCreated);
  registerEventHandler("dm.received", handleDmReceived);
  registerEventHandler("match.completed", handleMatchCompleted);
  // OpenClawCity partner-status events (the first-official-partner subscription).
  registerEventHandler("verification.revoked", handleVerificationRevoked);
  registerEventHandler("bot.created", handleBotCreated);
  registerEventHandler("bot.verified", handleBotVerified);
}
