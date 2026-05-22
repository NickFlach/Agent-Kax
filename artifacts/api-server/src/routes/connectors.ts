/**
 * connectors.ts — read-only enumeration of the connector registry.
 *
 *   GET /api/connectors            — list every known connector + whether
 *                                    it's available + which env vars are
 *                                    missing if not.
 *   GET /api/connectors/:id/agent/:slug
 *                                  — resolve an agent through a specific
 *                                    connector (useful for federation
 *                                    debugging).
 *   GET /api/connectors/:id/artifacts
 *                                  — proxy fetchArtifacts() so the UI
 *                                    can preview what a given connector
 *                                    is currently surfacing.
 */

import { Router, type IRouter } from "express";
import { ALL_CONNECTORS, findConnector, statusSnapshot } from "../connectors/registry";

const router: IRouter = Router();

router.get("/connectors", (_req, res) => {
  res.json({
    count: ALL_CONNECTORS.length,
    available: statusSnapshot().filter((s) => s.available).length,
    connectors: statusSnapshot(),
  });
});

router.get("/connectors/:id/agent/:slug", async (req, res) => {
  const c = findConnector(req.params["id"]!);
  if (!c) {
    res.status(404).json({ error: "Unknown connector" });
    return;
  }
  if (!c.isAvailable()) {
    res.status(503).json({ error: "Connector is not currently available", id: c.id });
    return;
  }
  try {
    const profile = await c.lookupAgent(req.params["slug"]!);
    if (!profile) {
      res.status(404).json({ error: "Agent not found on this connector" });
      return;
    }
    res.json({ connector: c.id, profile });
  } catch (err) {
    res.status(502).json({ error: "Connector error", detail: String(err) });
  }
});

router.get("/connectors/:id/artifacts", async (req, res) => {
  const c = findConnector(req.params["id"]!);
  if (!c) {
    res.status(404).json({ error: "Unknown connector" });
    return;
  }
  if (!c.isAvailable()) {
    res.status(503).json({ error: "Connector is not currently available", id: c.id });
    return;
  }
  const type = typeof req.query["type"] === "string" ? req.query["type"] : undefined;
  const creator = typeof req.query["creator"] === "string" ? req.query["creator"] : undefined;
  const cursor = typeof req.query["cursor"] === "string" ? req.query["cursor"] : null;
  const limitRaw = parseInt(String(req.query["limit"] ?? "20"), 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 20;
  try {
    const page = await c.fetchArtifacts({
      ...(type ? { type: type as never } : {}),
      ...(creator ? { creator } : {}),
      cursor,
      limit,
    });
    res.json({ connector: c.id, artifacts: page.artifacts, nextCursor: page.nextCursor });
  } catch (err) {
    res.status(502).json({ error: "Connector error", detail: String(err) });
  }
});

export default router;
