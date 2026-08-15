/**
 * actor.test.ts — one definition of who is acting, and of what they're called.
 *
 * The principal string is the join between an agent and its money. It used to
 * be derived inline in the ledger route, which meant any second subsystem
 * (presence, listings, the exchange) would have re-derived it and been free to
 * disagree — and a disagreement about a principal is a disagreement about who
 * owns a balance. These tests pin the derivation and the resolution order.
 */

import { describe, expect, it } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { principalForClaims, principalForAgent, principalForUser, resolveActor, ActorError } from "./actor";
import { authMiddleware } from "../middlewares/authMiddleware";

describe("principal derivation", () => {
  it("keys an agent on its OBC bot id, not its local row", () => {
    expect(principalForClaims({ kind: "agent", bot_id: "0f05e10b", sub: "ignored" })).toBe("kax:agent:0f05e10b");
    expect(principalForAgent({ obcBotId: "0f05e10b", id: 42 })).toBe("kax:agent:0f05e10b");
  });

  it("gives a bot-less agent a DIFFERENT shape, so it cannot collide", () => {
    // If a local-only agent were also "kax:agent:<n>", it could one day collide
    // with a real bot id and two different things would share one wallet.
    const local = principalForAgent({ obcBotId: null, id: 42 });
    expect(local).not.toMatch(/^kax:agent:/);
    expect(local).toBe("kax:kaxagent:42");
  });

  it("keys a user on their subject", () => {
    expect(principalForUser("user-7")).toBe("kax:user:user-7");
    expect(principalForClaims({ kind: "user", sub: "user-7" })).toBe("kax:user:user-7");
  });

  it("agrees with itself across both entry points", () => {
    const fromClaims = principalForClaims({ kind: "agent", bot_id: "abc", sub: "x" });
    const fromAgent = principalForAgent({ obcBotId: "abc", id: 1 });
    expect(fromClaims).toBe(fromAgent);
  });
});

function appWith(handler: express.RequestHandler): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authMiddleware);
  app.post("/who", handler);
  return app;
}

describe("resolveActor", () => {
  it("returns null when nobody is there", async () => {
    let seen: unknown = "unset";
    const app = appWith(async (req, res) => {
      seen = await resolveActor(req);
      res.json({ ok: true });
    });
    await request(app).post("/who").send({});
    expect(seen).toBeNull();
  });

  it("refuses an unverifiable token instead of falling through to the session", async () => {
    // The important half: a bad credential must not quietly become "anonymous",
    // or a caller could downgrade themselves into somebody else's path.
    let status = 0;
    const app = appWith(async (req, res) => {
      try {
        await resolveActor(req);
        res.json({ fellThrough: true });
      } catch (e) {
        status = e instanceof ActorError ? e.status : -1;
        res.status(status).json({ error: (e as Error).message });
      }
    });
    const r = await request(app).post("/who").set("Authorization", "Bearer nonsense").send({});
    expect(status).toBe(401);
    expect(r.status).toBe(401);
    expect(r.body.fellThrough).toBeUndefined();
  });
});
