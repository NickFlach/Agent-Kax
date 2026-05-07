import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { artifactsTable, dropsTable, activitiesTable } from "@workspace/db/schema";
import { eq, desc, count, avg, sql, isNotNull } from "drizzle-orm";
import { GetRecentActivityQueryParams } from "@workspace/api-zod";
import { getSyncState, DAILY_REQUEST_BUDGET, partnerApiAvailable } from "../lib/partnerClient";

const router: IRouter = Router();

router.get("/dashboard/partner-sync", async (_req, res) => {
  const state = await getSyncState();
  const today = new Date().toISOString().slice(0, 10);
  const requestsToday = state && state.requestsDayKey === today ? state.requestsToday : 0;
  res.json({
    apiKeyConfigured: partnerApiAvailable(),
    webhookSubscribed: state?.webhookSubscribed ?? "unknown",
    lastPollAt: state?.lastPollAt?.toISOString() ?? null,
    lastWebhookAt: state?.lastWebhookAt?.toISOString() ?? null,
    lastEventUuid: state?.lastEventUuid ?? null,
    lastArtifactCursor: state?.lastArtifactCursor ?? null,
    requestsToday,
    dailyBudget: DAILY_REQUEST_BUDGET,
  });
});

router.get("/dashboard/summary", async (req, res) => {
  const [
    totalArtifactsResult,
    scoredResult,
    narratedResult,
    totalDropsResult,
    publishedDropsResult,
    avgScoreResult,
    topCreatorsResult,
  ] = await Promise.all([
    db.select({ count: count() }).from(artifactsTable),
    db.select({ count: count() }).from(artifactsTable).where(isNotNull(artifactsTable.scoredAt)),
    db.select({ count: count() }).from(artifactsTable).where(isNotNull(artifactsTable.narratedAt)),
    db.select({ count: count() }).from(dropsTable),
    db.select({ count: count() }).from(dropsTable).where(eq(dropsTable.status, "published")),
    db.select({ avg: avg(artifactsTable.kannakaScore) }).from(artifactsTable),
    db
      .select({
        name: artifactsTable.creatorName,
        count: count(),
      })
      .from(artifactsTable)
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

router.get("/dashboard/recent-activity", async (req, res) => {
  const query = GetRecentActivityQueryParams.parse(req.query);
  const limit = query.limit ?? 10;

  const activities = await db
    .select()
    .from(activitiesTable)
    .orderBy(desc(activitiesTable.timestamp))
    .limit(limit);

  res.json({
    activities: activities.map((a) => ({
      ...a,
      timestamp: a.timestamp.toISOString(),
    })),
  });
});

router.get("/dashboard/score-distribution", async (req, res) => {
  const buckets = [
    { range: "0.0-0.2", min: 0, max: 0.2 },
    { range: "0.2-0.4", min: 0.2, max: 0.4 },
    { range: "0.4-0.6", min: 0.4, max: 0.6 },
    { range: "0.6-0.8", min: 0.6, max: 0.8 },
    { range: "0.8-1.0", min: 0.8, max: 1.01 },
  ];

  const results = await Promise.all(
    buckets.map(async (bucket) => {
      const result = await db
        .select({ count: count() })
        .from(artifactsTable)
        .where(
          sql`${artifactsTable.kannakaScore} >= ${bucket.min} AND ${artifactsTable.kannakaScore} < ${bucket.max}`
        );
      return { range: bucket.range, count: result[0].count };
    })
  );

  res.json({ buckets: results });
});

export default router;
