import app from "./app";
import { logger } from "./lib/logger";
import { ensureKannakaOwnerAndBackfill } from "./lib/backfill";
import { replayMissedEventsOnStartup } from "./lib/harvesterJob";
import { startAgentHarvestScheduler } from "./lib/scheduler";

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

ensureKannakaOwnerAndBackfill()
  .then(() => replayMissedEventsOnStartup())
  .then(() => startAgentHarvestScheduler())
  .catch((err) => {
    logger.error({ err }, "Failed to seed/backfill or replay events on startup");
  });

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
