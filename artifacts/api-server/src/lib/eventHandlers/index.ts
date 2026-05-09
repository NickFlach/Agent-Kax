import { registerEventHandler } from "../eventDispatcher";
import { handleArtifactCreated } from "./artifactCreated";
import { handleReactionReceived } from "./reactionReceived";
import { handleProposalCreated } from "./proposalCreated";
import { handleDmReceived } from "./dmReceived";
import { handleMatchCompleted } from "./matchCompleted";

let registered = false;

export function registerAllEventHandlers(): void {
  if (registered) return;
  registered = true;
  registerEventHandler("artifact.created", handleArtifactCreated);
  registerEventHandler("reaction.received", handleReactionReceived);
  registerEventHandler("proposal.created", handleProposalCreated);
  registerEventHandler("dm.received", handleDmReceived);
  registerEventHandler("match.completed", handleMatchCompleted);
}
