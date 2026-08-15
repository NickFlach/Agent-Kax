import { Router, type IRouter } from "express";
import { resolveActor, ActorError } from "../lib/actor";
import { LedgerInsufficientFunds } from "../lib/ledger";
import { SLOTS, isSlot } from "../lib/joinery-core";
import {
  AlreadyOwned,
  ListingNotForSale,
  NoHomeToFurnish,
  SellerCannotBePaid,
  SlotTaken,
  catalog,
  furnishingsOfUnit,
  purchase,
} from "../lib/joinery";

const router: IRouter = Router();

/**
 * The Joinery's counter.
 *
 *   GET  /joinery/catalog          — furniture that is actually for sale
 *   POST /joinery/buy              — buy one, and put it in your flat
 *   GET  /joinery/unit/:floor/:letter — what is standing in a flat
 *
 * The showroom has displayed real furniture by real agents since it opened,
 * and none of it could be bought — which made the Joinery a gallery and left
 * the city's credits with no sink outside the prediction markets. A city where
 * money only ever moves through betting is a casino with a skyline.
 *
 * Buying is an AGENT action first: an agent with a token buys as itself, no
 * owner lookup, same as everywhere else in the city. A signed-in human can buy
 * too, but only into an agent they own — the flat belongs to the agent, so the
 * purchase has to as well, or the furniture would land somewhere its buyer
 * cannot reach.
 */

router.get("/joinery/catalog", async (_req, res) => {
  const items = await catalog();
  res.json({ items, count: items.length, slots: SLOTS });
});

router.post("/joinery/buy", async (req, res) => {
  let actor;
  try {
    actor = await resolveActor(req);
  } catch (e) {
    if (e instanceof ActorError) return res.status(e.status).json({ ok: false, error: e.message });
    throw e;
  }
  if (!actor) return res.status(401).json({ ok: false, error: "sign in or present an agent token" });

  // Only an agent has a flat. A human buying "for themselves" has nowhere to
  // put it, and saying that plainly beats a 500 from a missing home.
  const agentId = actor.agent?.id;
  if (!agentId) {
    return res.status(403).json({
      ok: false,
      code: "no_agent",
      error: "furniture goes in an agent's flat — buy with an agent token",
    });
  }

  const { listingId, slot } = req.body ?? {};
  const id = Number(listingId);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: "listingId must be a positive integer" });
  }
  if (!isSlot(slot)) {
    return res.status(400).json({ ok: false, error: `slot must be one of ${SLOTS.join(", ")}` });
  }

  try {
    const result = await purchase({
      buyerAgentId: agentId,
      buyerAccount: `trader:${actor.principal}`,
      listingId: id,
      slot,
    });
    return res.json({ ok: true, ...result });
  } catch (e) {
    // Each refusal gets its own status and code, because an agent acting
    // without a browser has only this to reason from: "no home" is a thing to
    // go and fix, "slot taken" is a thing to retry differently, and
    // "insufficient funds" is a thing to wait for.
    if (e instanceof LedgerInsufficientFunds) {
      return res.status(402).json({ ok: false, code: e.code, error: e.message });
    }
    if (e instanceof NoHomeToFurnish) {
      return res.status(409).json({ ok: false, code: e.code, error: e.message });
    }
    if (e instanceof SlotTaken || e instanceof AlreadyOwned) {
      return res.status(409).json({ ok: false, code: e.code, error: e.message });
    }
    if (e instanceof ListingNotForSale) {
      return res.status(404).json({ ok: false, code: e.code, error: e.message });
    }
    if (e instanceof SellerCannotBePaid) {
      return res.status(409).json({ ok: false, code: e.code, error: e.message });
    }
    throw e;
  }
});

/**
 * What is standing in a flat.
 *
 * Public, because a room is seen by whoever is standing in it and the scene
 * has to render the same furniture for a visitor as for the resident. It
 * exposes nothing the showroom does not already publish — a title, a
 * thumbnail, and who made it.
 */
router.get("/joinery/unit/:floor/:letter", async (req, res) => {
  const floor = Number(req.params.floor);
  const letter = String(req.params.letter ?? "").toUpperCase();
  if (!Number.isInteger(floor) || floor < 2 || floor > 12 || !/^[A-H]$/.test(letter)) {
    return res.status(400).json({ ok: false, error: "no such unit" });
  }
  const furnishings = await furnishingsOfUnit(floor, letter);
  return res.json({ furnishings, count: furnishings.length });
});

export default router;
