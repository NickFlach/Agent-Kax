import type { EventHandler } from "../eventDispatcher";

function flagEnabled(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && /^(1|true|on|yes)$/i.test(v.trim());
}

function makeStub(eventType: string, flag: string): EventHandler {
  return async (data, { log }) => {
    if (!flagEnabled(flag)) {
      log.info({ eventType, flag }, "Stub event handler invoked; feature flag off — recording dedupe only");
      return;
    }
    // TODO: implement real handler when OBC ships this event family.
    log.info({ eventType, flag, data }, "Stub event handler invoked (flag on); no-op");
  };
}

export const handleProposalCreated: EventHandler = makeStub("proposal.created", "OBC_ENABLE_PROPOSALS");
export const handleDmReceived: EventHandler = makeStub("dm.received", "OBC_ENABLE_DMS");
export const handleMatchCompleted: EventHandler = makeStub("match.completed", "OBC_ENABLE_MATCHES");
