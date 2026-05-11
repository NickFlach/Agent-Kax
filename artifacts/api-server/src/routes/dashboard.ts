import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { artifactsTable, dropsTable, activitiesTable, reactionsTable } from "@workspace/db/schema";
import { eq, desc, count, avg, sql, isNotNull, and, gte, or, gt } from "drizzle-orm";
import { decayedHeatSignal } from "../lib/tasteEngine";
import { GetRecentActivityQueryParams } from "@workspace/api-zod";
import { getSyncState, DAILY_REQUEST_BUDGET, partnerApiAvailable } from "../lib/partnerClient";
import { requireAuth, getOwnerScope } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.get("/dashboard/partner-sync", async (_req, res) => {
  const state = await getSyncState();
  const today = new Date().toISOString().slice(0, 10);
  const requestsToday = state && state.requestsDayKey === today ? state.requestsToday : 0;

  const secretPresent = Boolean(process.env["OBC_WEBHOOK_SECRET"]);
  const STALE_MS = 24 * 60 * 60 * 1000;
  const lastWebhookMs = state?.lastWebhookAt?.getTime() ?? null;
  let webhookSubscribed: string;
  if (!secretPresent) {
    webhookSubscribed = "missing_secret";
  } else if (state?.webhookSubscribed === "active" && lastWebhookMs && Date.now() - lastWebhookMs < STALE_MS) {
    webhookSubscribed = "active";
  } else if (lastWebhookMs) {
    webhookSubscribed = "stale";
  } else {
    webhookSubscribed = "configured";
  }

  res.json({
    apiKeyConfigured: partnerApiAvailable(),
    webhookSubscribed,
    lastPollAt: state?.lastPollAt?.toISOString() ?? null,
    lastWebhookAt: state?.lastWebhookAt?.toISOString() ?? null,
    lastEventUuid: state?.lastEventUuid ?? null,
    lastArtifactCursor: state?.lastArtifactCursor ?? null,
    requestsToday,
    dailyBudget: DAILY_REQUEST_BUDGET,
  });
});

router.get("/dashboard/summary", requireAuth, async (req, res) => {
  const ownerScope = await getOwnerScope(req);
  const artifactScope = ownerScope !== null ? eq(artifactsTable.ownerId, ownerScope) : undefined;
  const dropScope = ownerScope !== null ? eq(dropsTable.ownerId, ownerScope) : undefined;
  const scoredCond = artifactScope
    ? and(isNotNull(artifactsTable.scoredAt), artifactScope)
    : isNotNull(artifactsTable.scoredAt);
  const narratedCond = artifactScope
    ? and(isNotNull(artifactsTable.narratedAt), artifactScope)
    : isNotNull(artifactsTable.narratedAt);
  const publishedCond = dropScope
    ? and(eq(dropsTable.status, "published"), dropScope)
    : eq(dropsTable.status, "published");

  const [
    totalArtifactsResult,
    scoredResult,
    narratedResult,
    totalDropsResult,
    publishedDropsResult,
    avgScoreResult,
    topCreatorsResult,
  ] = await Promise.all([
    db.select({ count: count() }).from(artifactsTable).where(artifactScope),
    db.select({ count: count() }).from(artifactsTable).where(scoredCond),
    db.select({ count: count() }).from(artifactsTable).where(narratedCond),
    db.select({ count: count() }).from(dropsTable).where(dropScope),
    db.select({ count: count() }).from(dropsTable).where(publishedCond),
    db.select({ avg: avg(artifactsTable.kannakaScore) }).from(artifactsTable).where(artifactScope),
    db
      .select({
        name: artifactsTable.creatorName,
        count: count(),
      })
      .from(artifactsTable)
      .where(artifactScope)
      .groupBy(artifactsTable.creatorName)
      .orderBy(desc(count()))
      .limit(5),
  ]);

  res.json({
    totalArtifacts: totalArtifactsResult[0].count,
    scoredArtifacts: scoredResult[0].count,
    narratedArtifacts: narratedResult[0].count,
    totalDrops: totalDropsResult[0].count,
    publishedDrops: publishedDropsResult[0].count,
    averageScore: Number(avgScoreResult[0].avg) || 0,
    topCreators: topCreatorsResult.map((c) => ({
      name: c.name,
      count: c.count,
    })),
  });
});

router.get("/dashboard/recent-activity", requireAuth, async (req, res) => {
  const query = GetRecentActivityQueryParams.parse(req.query);
  const limit = query.limit ?? 10;
  const ownerScope = await getOwnerScope(req);

  const activities = await db
    .select()
    .from(activitiesTable)
    .where(ownerScope !== null ? eq(activitiesTable.ownerId, ownerScope) : undefined)
    .orderBy(desc(activitiesTable.timestamp))
    .limit(limit);

  res.json({
    activities: activities.map((a) => ({
      ...a,
      timestamp: a.timestamp.toISOString(),
    })),
  });
});

router.get("/dashboard/score-distribution", requireAuth, async (req, res) => {
  const ownerScope = await getOwnerScope(req);
  // Buckets are half-open [min, max) except the top bucket which is the
  // closed [0.8, 1.0] so an artifact scoring exactly 1.0 lands in it
  // (previously a hacky 1.01 max with strict < meant 1.0 ended up
  // outside any bucket on some PG numeric types).
  const buckets = [
    { range: "0.0-0.2", min: 0, max: 0.2, inclusive: false },
    { range: "0.2-0.4", min: 0.2, max: 0.4, inclusive: false },
    { range: "0.4-0.6", min: 0.4, max: 0.6, inclusive: false },
    { range: "0.6-0.8", min: 0.6, max: 0.8, inclusive: false },
    { range: "0.8-1.0", min: 0.8, max: 1.0, inclusive: true },
  ];

  const results = await Promise.all(
    buckets.map(async (bucket) => {
      const upperOp = bucket.inclusive ? sql`<=` : sql`<`;
      const baseCond = sql`${artifactsTable.kannakaScore} >= ${bucket.min} AND ${artifactsTable.kannakaScore} ${upperOp} ${bucket.max}`;
      const where = ownerScope !== null ? and(baseCond, eq(artifactsTable.ownerId, ownerScope)) : baseCond;
      const result = await db
        .select({ count: count() })
        .from(artifactsTable)
        .where(where);
      return { range: bucket.range, count: result[0].count };
    })
  );

  res.json({ buckets: results });
});

router.get("/dashboard/hot", requireAuth, async (req, res) => {
  const ownerScope = await getOwnerScope(req);
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const decayWindowAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const recentCountSql = sql<number>`count(${reactionsTable.id}) filter (where ${reactionsTable.createdAt} >= ${hourAgo})`;
  // Show artifacts that are either actively hot (a reaction in the last hour)
  // OR were recently cooled by the decay job and still carry residual heat —
  // so curators can see why a previously-hot artifact's heat number dropped.
  const visibilityCond = or(
    and(isNotNull(artifactsTable.lastReactionAt), gte(artifactsTable.lastReactionAt, hourAgo)),
    and(
      isNotNull(artifactsTable.lastHeatDecayAt),
      gte(artifactsTable.lastHeatDecayAt, decayWindowAgo),
      gt(artifactsTable.heat, 0),
    ),
  );
  const conditions = [visibilityCond];
  if (ownerScope !== null) conditions.push(eq(artifactsTable.ownerId, ownerScope));

  const rows = await db
    .select({
      id: artifactsTable.id,
      title: artifactsTable.title,
      creatorName: artifactsTable.creatorName,
      thumbnailUrl: artifactsTable.thumbnailUrl,
      publicUrl: artifactsTable.publicUrl,
      artifactType: artifactsTable.artifactType,
      heat: artifactsTable.heat,
      previousHeat: artifactsTable.previousHeat,
      lastHeatDecayAt: artifactsTable.lastHeatDecayAt,
      lastReactionAt: artifactsTable.lastReactionAt,
      reactionsLastHour: recentCountSql,
    })
    .from(artifactsTable)
    .leftJoin(reactionsTable, eq(reactionsTable.artifactId, artifactsTable.id))
    .where(and(...conditions))
    .groupBy(artifactsTable.id)
    .orderBy(desc(recentCountSql), desc(artifactsTable.lastReactionAt))
    .limit(10);

  const now = new Date();
  const items = rows
    .map((r) => ({
      id: r.id,
      title: r.title,
      creatorName: r.creatorName,
      thumbnailUrl: r.thumbnailUrl,
      publicUrl: r.publicUrl,
      artifactType: r.artifactType,
      heat: r.heat,
      previousHeat: r.previousHeat,
      lastHeatDecayAt: r.lastHeatDecayAt?.toISOString() ?? null,
      reactionsLastHour: Number(r.reactionsLastHour) || 0,
      lastReactionAt: r.lastReactionAt?.toISOString() ?? null,
      heatSignal: decayedHeatSignal({ heat: r.heat, lastReactionAt: r.lastReactionAt, now }),
    }))
    .sort((a, b) => b.heatSignal - a.heatSignal || b.reactionsLastHour - a.reactionsLastHour);

  res.json({ items, windowMinutes: 60 });
});

export default router;
