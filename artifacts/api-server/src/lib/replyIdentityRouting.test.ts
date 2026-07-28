/**
 * replyIdentityRouting.test.ts — replies must go out as the agent that was
 * written to (#78).
 *
 * Inbound proposals and DMs record which of the owner's agents received them
 * (`agentId`), and partnerClient already supports `from_agent_slug` on outbound
 * sends. The reply routes never connected the two, so an owner with several
 * registered agents replied from OBC's default identity instead of the bot the
 * sender actually messaged — even though the row knew exactly which one it was.
 *
 * All three outbound paths are covered: proposal decision, proposal reply, DM
 * reply. Each is checked at its own call site rather than by counting matches
 * across the file, so a fix applied to one path cannot make the others pass.
 *
 * Source-level: this repo's DB-backed suite talks to a real database, which
 * must not be exercised from a dev machine.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "routes", "partner-events.ts"), "utf8");
const CLIENT = fs.readFileSync(path.join(__dirname, "partnerClient.ts"), "utf8");

/** The argument object of a given send call, from its opening to its `});`. */
function sendCall(fnName: string, nth: number): string {
  let from = 0;
  for (let i = 0; i <= nth; i++) {
    const at = SRC.indexOf(`await ${fnName}({`, from);
    expect(at, `call ${nth} to ${fnName} not found`).toBeGreaterThanOrEqual(0);
    if (i === nth) {
      const end = SRC.indexOf("});", at);
      expect(end).toBeGreaterThan(at);
      return SRC.slice(at, end);
    }
    from = at + 1;
  }
  throw new Error("unreachable");
}

describe("reply identity routing (#78)", () => {
  describe("the premise", () => {
    it("the partner client forwards fromAgentSlug on both send paths", () => {
      // If this stops being true the fix is inert, so it is worth pinning.
      expect(CLIENT).toContain('if (input.fromAgentSlug) body["from_agent_slug"] = input.fromAgentSlug;');
      const dmAt = CLIENT.indexOf("export async function sendPartnerDm");
      const replyAt = CLIENT.indexOf("export async function sendPartnerProposalReply");
      expect(dmAt).toBeGreaterThanOrEqual(0);
      expect(replyAt).toBeGreaterThan(dmAt);
      expect(CLIENT.slice(dmAt, replyAt)).toContain("from_agent_slug");
      expect(CLIENT.slice(replyAt)).toContain("from_agent_slug");
    });

    it("inbound rows carry the receiving agent, so the slug is knowable", () => {
      // The outbound record already stamps row.agentId — the information was
      // there all along, just never used for the send itself.
      expect(SRC).toContain("agentId: row.agentId");
    });
  });

  describe("every outbound path sends the receiving agent's slug", () => {
    it("proposal decision", () => {
      expect(sendCall("sendPartnerProposalReply", 0))
        .toContain("fromAgentSlug: await replyFromAgentSlug(row.agentId)");
    });

    it("proposal reply", () => {
      expect(sendCall("sendPartnerProposalReply", 1))
        .toContain("fromAgentSlug: await replyFromAgentSlug(row.agentId)");
    });

    it("DM reply", () => {
      expect(sendCall("sendPartnerDm", 0))
        .toContain("fromAgentSlug: await replyFromAgentSlug(row.agentId)");
    });

    it("no outbound send is left without it", () => {
      // Guards against a fourth path being added later without the slug.
      const calls = SRC.split("\n").filter((l) => /await sendPartner(Dm|ProposalReply)\(\{/.test(l));
      expect(calls.length).toBe(3);
    });
  });

  describe("the resolver", () => {
    const fn = SRC.slice(
      SRC.indexOf("async function replyFromAgentSlug"),
      SRC.indexOf("function partnerErrorResponse"),
    );

    it("resolves the slug from the receiving agent id", () => {
      expect(fn).toContain("eq(agentsTable.id, agentId)");
      expect(fn).toContain("slug: agentsTable.slug");
    });

    it("returns undefined for an unattributed event rather than guessing", () => {
      // An event never attributed to a local agent must omit from_agent_slug
      // and behave exactly as before, not pick some arbitrary identity.
      expect(fn).toContain("if (agentId === null) return undefined;");
      expect(fn).toContain("agent?.slug ?? undefined");
    });

    it("does not fall back to a default or first agent", () => {
      expect(fn).not.toContain("limit(1)\n    .then");
      expect(fn.includes("KANNAKA_AGENT_SLUG")).toBe(false);
    });
  });
});
