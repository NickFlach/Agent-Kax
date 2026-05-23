import app from "./app";
import { logger } from "./lib/logger";
import { ensureKannakaOwnerAndBackfill } from "./lib/backfill";
import { replayMissedEventsOnStartup } from "./lib/harvesterJob";
import { startAgentHarvestScheduler } from "./lib/scheduler";
import { startHeatDecayScheduler } from "./lib/heatDecayJob";
import { registerAllEventHandlers } from "./lib/eventHandlers";
import { start as startConstellationBridge } from "./lib/constellationBridge";
import { runMigrations } from "@workspace/db";

registerAllEventHandlers();

// Fail-fast on missing/blank critical secrets. Previously these were
// read inside routes and an empty string just made webhooks silently
// fail signature verification — which looks identical to a normal 401
// in logs and is impossible to debug. Validate at boot instead.
const requiredSecrets = ["OBC_WEBHOOK_SECRET", "OBC_PARTNER_API_KEY"];
const missingSecrets = requiredSecrets.filter((k) => {
  const v = process.env[k];
  return v == null || String(v).trim() === "";
});
if (missingSecrets.length > 0) {
  // In production this is fatal. In dev (NODE_ENV != production) we
  // warn so a developer running locally without OBC credentials can
  // still boot the API for non-webhook work.
  if (process.env["NODE_ENV"] === "production") {
    logger.error({ missing: missingSecrets }, "Missing required secrets — refusing to start");
    process.exit(1);
  } else {
    logger.warn({ missing: missingSecrets }, "Missing secrets (non-production — continuing)");
  }
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Optional auto-migrate at boot — production keeps migrations as a separate
// deploy step, but dev/CI/Replit setups can opt in with KAX_AUTO_MIGRATE=1
// so a fresh DB doesn't trip on missing tables before the manual step runs.
async function maybeAutoMigrate(): Promise<void> {
  if (process.env["KAX_AUTO_MIGRATE"] !== "1") return;
  try {
    const result = await runMigrations({ log: (m) => logger.info(m) });
    if (result.applied.length > 0) {
      logger.info({ applied: result.applied }, "schema_migrations: applied at boot");
    }
  } catch (err) {
    logger.error({ err }, "schema_migrations: auto-migrate failed");
    // Don't refuse to start — operators may prefer hand-applied migrations
    // and just want the runner available; the real fail-loudly path is
    // `pnpm --filter @workspace/db migrate` exiting non-zero.
  }
}

maybeAutoMigrate()
  .then(() => ensureKannakaOwnerAndBackfill())
  .then(() => replayMissedEventsOnStartup())
  .then(() => startAgentHarvestScheduler())
  .then(() => startHeatDecayScheduler())
  .then(() => startConstellationBridge())
  .catch((err) => {
    logger.error({ err }, "Failed to seed/backfill, replay events, or start constellation bridge");
  });

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
