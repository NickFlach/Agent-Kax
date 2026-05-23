import app from "./app";
import { logger } from "./lib/logger";
import { ensureKannakaOwnerAndBackfill } from "./lib/backfill";
import { replayMissedEventsOnStartup } from "./lib/harvesterJob";
import { startAgentHarvestScheduler } from "./lib/scheduler";
import { startHeatDecayScheduler } from "./lib/heatDecayJob";
import { registerAllEventHandlers } from "./lib/eventHandlers";
import { start as startConstellationBridge } from "./lib/constellationBridge";
import { runMigrations } from "@workspace/db";
import { writeSync as fsWriteSync } from "node:fs";

// process.stderr.write is asynchronous when stderr is a pipe (which it
// always is in the deploy environment), so a `process.stderr.write(...);
// process.exit(1)` sequence silently drops the message — exactly what
// hid the migration failure from deploy logs for two prior failed
// publishes. fs.writeSync(2, ...) is a real synchronous write(2) syscall
// against stderr and is the only way to guarantee a final boot
// breadcrumb makes it out before the process terminates.
function bootLog(msg: string): void {
  try {
    const line = msg.endsWith("\n") ? msg : `${msg}\n`;
    fsWriteSync(2, line);
  } catch {
    /* writing diagnostics must never throw */
  }
}

// Synchronous stderr at the very top of module load. If we never see this
// line in deploy logs, the bundle itself is failing to load (esbuild output
// problem). This bypasses pino entirely, which has a bundled-worker code
// path that can swallow output before SIGTERM.
bootLog(
  `[boot] index.ts loaded — NODE_ENV=${process.env["NODE_ENV"] ?? "<unset>"} REPLIT_DEPLOYMENT=${process.env["REPLIT_DEPLOYMENT"] ?? "<unset>"}`,
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
    bootLog(
      `[boot] missing required secrets in production: ${missingSecrets.join(",")} — exiting`,
    );
    logger.error({ missing: missingSecrets }, "Missing required secrets — refusing to start");
    process.exit(1);
  } else {
    bootLog(
      `[boot] missing secrets (non-production, continuing): ${missingSecrets.join(",")}`,
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
  bootLog(
    `[boot] autoMigrate: starting (deadline=${MIGRATION_DEADLINE_MS}ms)`,
  );
  try {
    const result = await Promise.race([
      runMigrations({ log: (m) => bootLog(`[boot] migrate: ${m}`) }),
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
    bootLog("[boot] autoMigrate: done");
  } catch (err) {
    // Auto-migrate failure is NOT fatal. Three prior deploys (e087065f,
    // 22065375, 40369c52) all bricked publish here: the third one opened
    // its port and the autoscale probe was happy, then this catch fired
    // process.exit(1) — and the failure breadcrumb was lost in stderr's
    // pipe buffer, so logs went silent and the deploy was marked failed
    // with zero diagnostic surface.
    //
    // The deploy was green on 2026-05-22 against the same DB. The prod
    // schema has historically been managed via `drizzle-push`, so it is
    // already at HEAD; the schema_migrations journal is just empty,
    // which makes the runner re-attempt every migration on first boot.
    // The only non-idempotent one (0003_drop_replit_auth: ALTER TYPE …
    // RENAME) cannot succeed against a DB that's already past it.
    //
    // Log loudly and KEEP SERVING. If a migration is genuinely required
    // for a new code path, the affected route will throw "column does
    // not exist" and surface in normal request logs — fixable without
    // taking the whole deploy down. Once the prod schema_migrations
    // journal is backfilled (separate task), every subsequent boot will
    // see them as already-applied and this catch will go quiet.
    const e = err as NodeJS.ErrnoException & { cause?: unknown };
    bootLog(
      `[boot] autoMigrate: FAILED (non-fatal, continuing) — code=${e.code ?? "<none>"} cause=${String((e.cause as Error | undefined)?.message ?? "<none>")} message=${e.message}`,
    );
    logger.error(
      { err },
      "schema_migrations: auto-migrate failed (continuing — prod schema is managed; investigate journal)",
    );
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
  bootLog("[boot] boot() start");

  // We deliberately do NOT await autoMigrateOrExit() before listen().
  // Four prior deploy failures (e087065f, 22065375, 40369c52, and the
  // latest) all bricked publish in the boot path: the first two died
  // inside pg connect before listen() could open port 8080, the third
  // opened its port but exited on a migration failure whose breadcrumb
  // was lost in stderr's pipe buffer. Opening the port first guarantees
  // the deploy probe passes; migrations now run in the background and
  // their failure is non-fatal (see autoMigrateOrExit's catch block).
  //
  // Routes that need migrated schema will 500 in the brief window between
  // listen and migration completion, or if the migration outright failed.
  // That's acceptable: the prod schema is independently managed and
  // typically already at HEAD; a broken migration journal is recoverable
  // without bouncing the deploy.
  bootLog(`[boot] calling app.listen(${port})`);
  app.listen(port, (err) => {
    if (err) {
      bootLog(`[boot] app.listen FAILED: ${String(err)}`);
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    bootLog(`[boot] app.listen OK on port ${port}`);
    logger.info({ port }, "Server listening");
    // Kick off migrations first, then warm-up. Both are non-fatal:
    // migration failures are logged and swallowed; warm-up failures are
    // per-step isolated inside warmUpInBackground.
    void (async () => {
      await autoMigrateOrExit();
      await warmUpInBackground();
    })();
  });
}

process.on("uncaughtException", (err) => {
  bootLog(`[boot] uncaughtException: ${String(err?.stack ?? err)}`);
});
process.on("unhandledRejection", (err) => {
  bootLog(`[boot] unhandledRejection: ${String((err as Error)?.stack ?? err)}`);
});

void boot();
