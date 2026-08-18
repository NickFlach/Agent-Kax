import { Router, type IRouter } from "express";
import { resolveActor, ActorError } from "../lib/actor";
import { LedgerInsufficientFunds } from "../lib/ledger";
import { MissingListPrice, SLOTS, isSlot, parseListPrice } from "../lib/joinery-core";
import {
  AlreadyOwned,
  BadListPrice,
  NotFurniture,
  ListingNotForSale,
  NoHomeToFurnish,
  SellerCannotBePaid,
  SellerFrozen,
  SlotTaken,
  catalog,
  furnishingsOfUnit,
  list,
  listingsOfAgent,
  worksForSale,
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

router.get("/joinery/catalog", async (req, res) => {
  // count is what this page holds; total is what is on sale. They were the
  // same field once, which is how the city ended up believing it had eighteen
  // pieces of furniture when it had 339.
  const page = await catalog(Number(req.query.limit) || 40, Number(req.query.offset) || 0);
  res.json({ items: page.items, count: page.items.length, total: page.total, truncated: page.truncated, slots: SLOTS });
});

/**
 * Put a piece on sale, or take it off.
 *
 * The Joinery could be STOCKED only by a signed-in human who owned the store,
 * so eighteen pieces of furniture made by agents sat in the showroom and not
 * one could be sold by the agent that made it — a counter in front of empty
 * shelves. An agent prices its own work here, as itself.
 *
 * price: null takes it off sale without unlisting it. The showroom keeps
 * showing the piece; the catalogue stops offering it.
 */
router.post("/joinery/sell", async (req, res) => {
  let actor;
  try {
    actor = await resolveActor(req);
  } catch (e) {
    if (e instanceof ActorError) return res.status(e.status).json({ ok: false, error: e.message });
    throw e;
  }
  if (!actor) return res.status(401).json({ ok: false, error: "sign in or present an agent token" });
  if (!actor.agent?.id) {
    return res.status(403).json({ ok: false, code: "no_agent", error: "a store belongs to an agent — sell as one" });
  }

  const { artifactId, note } = req.body ?? {};
  const id = Number(artifactId);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: "artifactId must be a positive integer" });
  }
  try {
    const result = await list({
      sellerAgentId: actor.agent.id,
      artifactId: id,
      price: parseListPrice(req.body ?? {}),
      note: typeof note === "string" ? note.slice(0, 280) : undefined,
    });
    return res.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof MissingListPrice) return res.status(400).json({ ok: false, code: e.code, error: e.message });
    if (e instanceof BadListPrice) return res.status(400).json({ ok: false, code: e.code, error: e.message });
    if (e instanceof NotFurniture) return res.status(400).json({ ok: false, code: e.code, error: e.message });
    if (e instanceof SellerCannotBePaid) return res.status(409).json({ ok: false, code: e.code, error: e.message });
    // Rule six: the seller's verification was withdrawn. 403, because unlike
    // the unpayable case this is the city refusing them, not a fact about the
    // shape of their account.
    if (e instanceof SellerFrozen) return res.status(403).json({ ok: false, code: e.code, error: e.message });
    throw e;
  }
});

/**
 * The furniture you have made, with the ids you need to sell it.
 *
 * Without this, /joinery/sell takes an artifactId that nothing in the city
 * would tell an agent — a route that validates its input and cannot be called
 * correctly by anybody without a browser.
 */
router.get("/joinery/works", async (req, res) => {
  let actor;
  try {
    actor = await resolveActor(req);
  } catch (e) {
    if (e instanceof ActorError) return res.status(e.status).json({ ok: false, error: e.message });
    throw e;
  }
  if (!actor?.agent?.id) {
    return res.status(403).json({ ok: false, code: "no_agent", error: "works belong to an agent" });
  }
  const page = await worksForSale(
    { id: actor.agent.id, obcBotId: actor.agent.obcBotId ?? null },
    { limit: Number(req.query.limit) || 100, offset: Number(req.query.offset) || 0 },
  );
  return res.json({ works: page.works, count: page.works.length, total: page.total, truncated: page.truncated });
});

/** What this agent's store currently offers, priced or not. */
router.get("/joinery/mine", async (req, res) => {
  let actor;
  try {
    actor = await resolveActor(req);
  } catch (e) {
    if (e instanceof ActorError) return res.status(e.status).json({ ok: false, error: e.message });
    throw e;
  }
  if (!actor?.agent?.id) {
    return res.status(403).json({ ok: false, code: "no_agent", error: "a store belongs to an agent" });
  }
  return res.json({ listings: await listingsOfAgent(actor.agent.id) });
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
    if (e instanceof SellerFrozen) {
      // The stall is shut, not sold out. Told plainly so the buyer does not go
      // looking for a price that is not coming back while the freeze holds.
      return res.status(403).json({ ok: false, code: e.code, error: e.message });
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
