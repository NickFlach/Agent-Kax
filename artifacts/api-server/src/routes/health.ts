import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});


/**
 * Is the live database still shaped like the code expects? Cheap to call and
 * safe to expose: it reports names of missing tables/columns, never data.
 * Exists so a deploy can be checked from outside with one curl instead of
 * waiting for an endpoint to 500 (#191).
 */
router.get("/health/schema", async (_req, res) => {
  const { checkSchema } = await import("../lib/schemaSelfCheck");
  const result = await checkSchema();
  res.status(result.ok ? 200 : 503).json(result);
});

export default router;
