import type { Request } from "express";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { agentsTable, type Agent } from "@workspace/db/schema";
import { getOptionalAuth } from "../middlewares/requireAuth";
import type { IdentityClaims, PrincipalKind } from "./identity";

/**
 * Who is acting, in one place.
 *
 * An agent used to exist in about seven forms — an OBC bot UUID, a KAX agents
 * row, an owner user, an identity-token subject, a ledger principal, and soon a
 * presence entry — and each route derived what it needed by hand. That gap is
 * where the housing bug lived: agents harvested from OBC are owned by the
 * system user, so an endpoint that authorised via ownership could never
 * authorise the residents themselves, and we shipped an offer nobody could take.
 *
 * The rule this module encodes: THE OBC BOT UUID IS THE CANONICAL AGENT
 * IDENTITY. Everything else is a projection of it. Human ownership is an
 * ATTRIBUTE of an agent, never the path by which an agent is allowed to act —
 * otherwise the city belongs to whoever holds a login.
 */

export interface Actor {
  kind: PrincipalKind;
  /**
   * The canonical principal string used by the ledger today, and by presence
   * and listings as they arrive: `kax:agent:<bot_id>` or `kax:<kind>:<sub>`.
   * Derived HERE and nowhere else, so two subsystems cannot disagree about
   * who owns a balance.
   */
  principal: string;
  /** The OBC bot UUID, when this actor is an agent. */
  botId?: string;
  /** The KAX agent row, when one exists for that bot. */
  agent?: Agent;
  /** The signed-in user, when the actor arrived with a session. */
  userId?: string;
  /** How the claim was proved — useful in logs and for deciding what to allow. */
  via: "identity-token" | "session";
}

/** The one definition of a principal string. */
export function principalForClaims(c: Pick<IdentityClaims, "kind" | "bot_id" | "sub">): string {
  if (c.kind === "agent" && c.bot_id) return `kax:agent:${c.bot_id}`;
  return `kax:${c.kind}:${c.sub}`;
}

export function principalForAgent(agent: Pick<Agent, "obcBotId" | "id">): string {
  // An agent with no bot id has never been seen in OBC. It still needs a stable
  // principal, so fall back to its local row — but never silently reuse the
  // agent-shaped form, or two different things would share one wallet.
  return agent.obcBotId ? `kax:agent:${agent.obcBotId}` : `kax:kaxagent:${agent.id}`;
}

export function principalForUser(userId: string): string {
  return `kax:user:${userId}`;
}

export class ActorError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Resolve the actor behind a request. Two doors, checked in this order:
 *
 *   1. An identity token (Authorization: Bearer). This is the agent's own door
 *      and must be tried FIRST — an agent holding a valid token should never
 *      fall through to a session path and act as somebody else.
 *   2. A signed-in KAX user session.
 *
 * Returns null when neither is present. Throws ActorError(401) when a token is
 * present but does not verify — an unverifiable credential is a refusal, not
 * an invitation to try the next door.
 */
export async function resolveActor(req: Request): Promise<Actor | null> {
  const bearer = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? "");
  if (bearer) {
    const { verifyToken } = await import("./identity");
    const v = await verifyToken(bearer[1]!);
    if (!v.ok) throw new ActorError(`token did not verify: ${v.error}`, 401);
    const c = v.claims;
    const principal = principalForClaims(c);

    if (c.kind === "agent" && c.bot_id) {
      const [agent] = await db
        .select()
        .from(agentsTable)
        .where(eq(agentsTable.obcBotId, c.bot_id))
        .limit(1);
      return { kind: c.kind, principal, botId: c.bot_id, agent, via: "identity-token" };
    }
    return { kind: c.kind, principal, userId: typeof c.sub === "string" ? c.sub : undefined, via: "identity-token" };
  }

  const auth = await getOptionalAuth(req);
  if (!auth) return null;
  return { kind: "user", principal: principalForUser(auth.id), userId: auth.id, via: "session" };
}

/**
 * The agent an actor is entitled to act AS.
 *
 * An agent token acts as itself — no ownership lookup, which is the whole
 * point. A user session may act for an agent it owns, named explicitly.
 */
export async function agentForActor(
  actor: Actor,
  req: Request,
  requestedAgentId?: unknown,
): Promise<Agent> {
  if (actor.kind === "agent") {
    if (!actor.agent) {
      throw new ActorError("no agent record for this bot yet — get harvested first", 404);
    }
    return actor.agent;
  }

  const id = Number(requestedAgentId);
  if (!Number.isInteger(id) || id <= 0) throw new ActorError("agentId required", 400);
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id)).limit(1);
  if (!agent) throw new ActorError("Agent not found", 404);

  const { canMutate } = await import("../middlewares/requireAuth");
  if (!(await canMutate(req, agent.ownerId))) throw new ActorError("Not your agent", 403);
  return agent;
}
