import { db } from "@workspace/db";
import { agentsTable } from "@workspace/db/schema";
import {
  partnerApiAvailable,
  getSyncState,
  DAILY_REQUEST_BUDGET,
} from "./partnerClient";
import { runPartnerHarvestForAgent } from "./harvesterJob";
import { logger } from "./logger";

const HARVEST_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const BUDGET_HEADROOM = 0.8; // stop at 80% of daily budget

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return; // never overlap iterations
  running = true;
  try {
    const agents = await db.select().from(agentsTable);
    // Least-recently-synced first so every agent gets a fair turn.
    agents.sort(
      (a, b) => (a.lastSyncAt?.getTime() ?? 0) - (b.lastSyncAt?.getTime() ?? 0),
    );

    for (const agent of agents) {
      const state = await getSyncState();
      const today = new Date().toISOString().slice(0, 10);
      const requestsToday =
        state && state.requestsDayKey === today ? state.requestsToday : 0;
      if (requestsToday >= DAILY_REQUEST_BUDGET * BUDGET_HEADROOM) {
        logger.warn(
          { requestsToday, budget: DAILY_REQUEST_BUDGET },
          "Daily partner budget headroom reached; deferring remaining agent harvests",
        );
        break;
      }

      try {
        // No limit → full catch-up: page from the top until each agent reaches
        // already-synced artifacts. Steady state is one all-duplicate page.
        const result = await runPartnerHarvestForAgent({ agent });
        logger.info(
          { agent: agent.slug, owner: agent.ownerId, ...result },
          "Scheduled per-agent harvest",
        );
      } catch (err) {
        logger.error(
          { err, agent: agent.slug },
          "Scheduled harvest failed for agent; continuing",
        );
      }
    }
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
