import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

/** When this process came up — distinguishes "redeployed" from "restarted". */
const STARTED_AT = new Date().toISOString();

// Injected by build.mjs at bundle time. Declared, not defined, so a dev run
// that never goes through esbuild simply reports "dev".
declare const __BUILD_SHA__: string | undefined;
declare const __BUILT_AT__: string | undefined;

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

/**
 * Which build is this?
 *
 * Answering "did my deploy land?" used to mean probing for a feature and
 * inferring — slow, and ambiguous in the worst way: a missing route and a
 * legitimate "not found" both answer 404, so the check needed to read response
 * BODIES to tell "this code isn't deployed" from "the code is deployed and the
 * answer is no". That cost real time across the 2026-08-15 deploys.
 *
 * The commit is stamped into the bundle at build time, so this is one request
 * and no inference. Public because a build id is not a secret and a health
 * check you must authenticate to is one you cannot use from outside.
 */
router.get("/version", (_req, res) => {
  res.json({
    // Injected by build.mjs; the fallbacks are what a dev-mode (unbundled)
    // process reports, which is honest rather than a made-up sha.
    commit: typeof __BUILD_SHA__ === "string" ? __BUILD_SHA__ : "dev",
    builtAt: typeof __BUILT_AT__ === "string" ? __BUILT_AT__ : null,
    startedAt: STARTED_AT,
  });
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

/**
 * The authority engine's ageing alert (#266): outcome_unknown reservations
 * older than the threshold. Each one pins cap headroom for its principal
 * until a reconciler resolves it, so a non-empty list is an operator event —
 * 503, same contract as /health/schema. Reports ids and ages, never postings.
 */
router.get("/health/authority", async (_req, res) => {
  try {
    const { ageingOutcomeUnknown, OUTCOME_UNKNOWN_AGEING_MS } = await import("../lib/authorityPolicy");
    const ageing = await ageingOutcomeUnknown();
    res.status(ageing.length === 0 ? 200 : 503).json({
      ok: ageing.length === 0,
      thresholdMs: OUTCOME_UNKNOWN_AGEING_MS,
      ageingOutcomeUnknown: ageing.map((r) => ({
        reservationId: r.reservationId,
        principal: r.principal,
        amountMinor: r.amountMinor.toString(),
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    // The check itself failing (table missing, no DB) is a 503 with the
    // error named — fail-closed reporting, matching the engine's own rule.
    res.status(503).json({ ok: false, error: (e as Error)?.message ?? "authority health check failed" });
  }
});

export default router;
