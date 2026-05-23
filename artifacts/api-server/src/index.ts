import app from "./app";
import { logger } from "./lib/logger";
import { ensureKannakaOwnerAndBackfill } from "./lib/backfill";
import { replayMissedEventsOnStartup } from "./lib/harvesterJob";
import { startAgentHarvestScheduler } from "./lib/scheduler";
import { startHeatDecayScheduler } from "./lib/heatDecayJob";
import { registerAllEventHandlers } from "./lib/eventHandlers";
import { start as startConstellationBridge } from "./lib/constellationBridge";
import { runMigrations } from "@workspace/db";

// Synchronous stderr at the very top of module load. If we never see this
// line in deploy logs, the bundle itself is failing to load (esbuild output
// problem). This bypasses pino entirely, which has a bundled-worker code
// path that can swallow output before SIGTERM.
process.stderr.write(
  `[boot] index.ts loaded — NODE_ENV=${process.env["NODE_ENV"] ?? "<unset>"} REPLIT_DEPLOYMENT=${process.env["REPLIT_DEPLOYMENT"] ?? "<unset>"}\n`,
);

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
    process.stderr.write(
      `[boot] missing required secrets in production: ${missingSecrets.join(",")} — exiting\n`,
    );
    logger.error({ missing: missingSecrets }, "Missing required secrets — refusing to start");
    process.exit(1);
  } else {
    process.stderr.write(
      `[boot] missing secrets (non-production, continuing): ${missingSecrets.join(",")}\n`,
    );
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

// Auto-migrate at boot. Enabled by default on Replit deployments
// (REPLIT_DEPLOYMENT=1) so production never serves with a stale schema
// after a deploy that ships new migrations. Dev/CI can opt in explicitly
// with KAX_AUTO_MIGRATE=1, or opt out of the deploy default with
// KAX_AUTO_MIGRATE=0. A failure here is fatal — we'd rather refuse to
// boot than answer requests against a half-migrated schema (the exact
// "column does not exist" 500 storm task #36 had to clean up by hand).
function shouldAutoMigrate(): boolean {
  const flag = process.env["KAX_AUTO_MIGRATE"];
  if (flag === "1") return true;
  if (flag === "0") return false;
  return process.env["REPLIT_DEPLOYMENT"] === "1";
}

// Hard deadline for the migration step. The autoscale runner SIGTERMs the
// process if port 8080 doesn't open within ~60s, so we cannot let migrations
// hang on a stuck DB connection (pg + bundled pino can swallow the only
// signal we'd otherwise see). If we blow this budget, fail loudly to
// stderr — which is guaranteed to surface in deploy logs — and exit.
// Overridable via KAX_MIGRATION_DEADLINE_MS to leave headroom for cold-DB
// wake-up scenarios where legitimate migrations may need 40–50s.
const MIGRATION_DEADLINE_MS = (() => {
  const raw = process.env["KAX_MIGRATION_DEADLINE_MS"];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
})();

async function autoMigrateOrExit(): Promise<void> {
  if (!shouldAutoMigrate()) return;
  // stderr is synchronous and guaranteed visible in deploy logs even if
  // pino's bundled stdout path is buffered or wedged.
  process.stderr.write(
    `[boot] autoMigrate: starting (deadline=${MIGRATION_DEADLINE_MS}ms)\n`,
  );
  try {
    const result = await Promise.race([
      runMigrations({ log: (m) => process.stderr.write(`[boot] migrate: ${m}\n`) }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`migration deadline exceeded (${MIGRATION_DEADLINE_MS}ms)`)),
          MIGRATION_DEADLINE_MS,
        ),
      ),
    ]);
    if (result.applied.length > 0) {
      logger.info(
        { applied: result.applied, skipped: result.skipped.length },
        "schema_migrations: applied at boot",
      );
    } else {
      logger.info(
        { skipped: result.skipped.length },
        "schema_migrations: up to date at boot",
      );
    }
    process.stderr.write("[boot] autoMigrate: done\n");
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { cause?: unknown };
    process.stderr.write(
      `[boot] autoMigrate: FAILED — code=${e.code ?? "<none>"} cause=${String((e.cause as Error | undefined)?.message ?? "<none>")} message=${e.message}\n`,
    );
    logger.error({ err }, "schema_migrations: auto-migrate failed — refusing to start");
    process.exit(1);
  }
}

// Background warm-up. Intentionally NOT awaited before app.listen() —
// each of these calls out to the partner API (replay walks paginated
// event feeds; backfill calls getPartnerAgent) or to NATS (constellation
// bridge), and on a cold deploy any of them can take well over the 60s
// the Replit runner waits for port 8080 to open. Pre-#40 these ran
// after listen(); #40 (auto-migrate) accidentally awaited them too,
// which is what bricked the publish.
async function runStartupStep(
  name: string,
  fn: () => unknown | Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    logger.info({ step: name }, "startup step completed");
  } catch (err) {
    // Per-step isolation: a partner-API hiccup in backfill or replay must
    // NOT prevent the harvest/heat schedulers or constellation bridge from
    // starting. Pre-fix, one shared try/catch around the sequential chain
    // meant a single transient failure would silently disable ingestion
    // and decay for the entire process lifetime.
    logger.error({ step: name, err }, "startup step failed (continuing)");
  }
}

async function warmUpInBackground(): Promise<void> {
  await runStartupStep("ensureKannakaOwnerAndBackfill", ensureKannakaOwnerAndBackfill);
  await runStartupStep("replayMissedEventsOnStartup", replayMissedEventsOnStartup);
  await runStartupStep("startAgentHarvestScheduler", startAgentHarvestScheduler);
  await runStartupStep("startHeatDecayScheduler", startHeatDecayScheduler);
  await runStartupStep("startConstellationBridge", startConstellationBridge);
}

async function boot(): Promise<void> {
  process.stderr.write("[boot] boot() start\n");
  // Migrations MUST complete before we accept traffic — otherwise routes
  // 500 against a stale schema (see task #36). Everything else is
  // best-effort warm-up and runs after the port opens.
  await autoMigrateOrExit();

  process.stderr.write(`[boot] calling app.listen(${port})\n`);
  app.listen(port, (err) => {
    if (err) {
      process.stderr.write(`[boot] app.listen FAILED: ${String(err)}\n`);
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    process.stderr.write(`[boot] app.listen OK on port ${port}\n`);
    logger.info({ port }, "Server listening");
    void warmUpInBackground();
  });
}

process.on("uncaughtException", (err) => {
  process.stderr.write(`[boot] uncaughtException: ${String(err?.stack ?? err)}\n`);
});
process.on("unhandledRejection", (err) => {
  process.stderr.write(`[boot] unhandledRejection: ${String((err as Error)?.stack ?? err)}\n`);
});

void boot();
