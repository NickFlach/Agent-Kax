import {
  partnerApiAvailable,
  hasPartnerBudgetHeadroom,
  DAILY_REQUEST_BUDGET,
} from "./partnerClient";
import { runPartnerHarvest } from "./harvesterJob";
import { logger } from "./logger";

const HARVEST_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return; // never overlap iterations
  running = true;
  try {
    if (!(await hasPartnerBudgetHeadroom())) {
      logger.warn(
        { budget: DAILY_REQUEST_BUDGET },
        "Daily partner budget headroom reached; deferring harvest",
      );
      return;
    }

    // Single global top-anchored pass. The OBC partner feed ignores the
    // creator filter, so one run ingests every creator's new work and
    // attributes each artifact by bot UUID (see runPartnerHarvest).
    const result = await runPartnerHarvest();
    logger.info({ ...result }, "Scheduled global harvest");
  } catch (err) {
    logger.error({ err }, "Scheduler iteration failed");
  } finally {
    running = false;
  }
}

export function startAgentHarvestScheduler(): void {
  if (!partnerApiAvailable()) {
    logger.info("Partner API not configured; skipping agent harvest scheduler");
    return;
  }
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, HARVEST_INTERVAL_MS);
  logger.info(
    { intervalMs: HARVEST_INTERVAL_MS },
    "Agent harvest scheduler started",
  );
  // Run an immediate first tick so ingestion does not wait a full interval.
  void tick();
}
