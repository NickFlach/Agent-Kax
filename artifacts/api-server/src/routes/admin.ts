import { Router, type IRouter } from "express";
import { db, runMigrations, listMigrationFiles, listAppliedMigrations, backfillJournal } from "@workspace/db";
import { usersTable, agentsTable, artifactsTable, dropsTable } from "@workspace/db/schema";
import { and, desc, eq, isNull, ne, sql, count } from "drizzle-orm";
import { requireAdmin, requireAdminOrServiceToken } from "../middlewares/requireAuth";
import { ListAdminUsersResponse, UpdateAdminUserBody, UpdateAdminUserParams } from "@workspace/api-zod";
import { reattributeArtifactsByCreator, repairPlaceholderAgentNames } from "../lib/backfill";
import {
  partnerApiAvailable,
  partnerApiKey,
  getSyncState,
  listPartnerEventsSince,
  recordEventCursor,
  PartnerApiError,
} from "../lib/partnerClient";
import { fetchPublicGallery } from "../lib/publicClient";
import { dispatchPartnerEvent } from "../lib/eventDispatcher";
import { publish as publishConstellation } from "../lib/constellationBridge";

const router: IRouter = Router();

function formatUser(u: typeof usersTable.$inferSelect) {
  return {
    id: u.id,
    email: u.email ?? null,
    firstName: u.firstName ?? null,
    lastName: u.lastName ?? null,
    displayName: u.displayName ?? null,
    profileImageUrl: u.profileImageUrl ?? null,
    bio: u.bio ?? null,
    role: u.role,
    disabledAt: u.disabledAt ? u.disabledAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  };
}

router.get("/admin/users", requireAdmin, async (_req, res) => {
  const users = await db.select().from(usersTable).orderBy(desc(usersTable.createdAt));
  res.json(ListAdminUsersResponse.parse({ users: users.map(formatUser) }));
});

router.patch("/admin/users/:id", requireAdmin, async (req, res) => {
  const { id } = UpdateAdminUserParams.parse(req.params);
  const body = UpdateAdminUserBody.parse(req.body);

  const updates: Record<string, unknown> = {};
  if (body.role !== undefined) updates.role = body.role;
  if (body.disabled !== undefined) updates.disabledAt = body.disabled ? new Date() : null;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  if (req.user && req.user.id === id) {
    if (body.role === "user" || body.disabled === true) {
      res.status(400).json({ error: "You cannot demote or disable your own admin account" });
      return;
    }
  }

  const willRemoveAdmin = body.role === "user" || body.disabled === true;
  if (willRemoveAdmin) {
    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (target && target.role === "admin" && !target.disabledAt) {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(usersTable)
        .where(and(eq(usersTable.role, "admin"), isNull(usersTable.disabledAt), ne(usersTable.id, id)));
      if (count === 0) {
        res.status(409).json({ error: "Cannot remove the last active admin" });
        return;
      }
    }
  }

  const [updated] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(formatUser(updated));
});

router.post("/admin/reattribute-artifacts", requireAdmin, async (req, res) => {
  const result = await reattributeArtifactsByCreator({
    ownerId: req.user!.id,
    dryRun: req.query["dryRun"] === "true",
  });
  res.json(result);
});

// Rename unclaimed agents stuck on a "Agent <hex>" placeholder by resolving
// their real display name from the public catalog. Because the catalog walk
// takes minutes (well past any HTTP gateway timeout), this runs as a
// background job: POST starts it and returns immediately; GET polls status.
// Admin session or service token (maintenance op, re-runnable as the
// harvester pulls more agents).
type RepairJob = {
  status: "running" | "done" | "error";
  dryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  result: Awaited<ReturnType<typeof repairPlaceholderAgentNames>> | null;
  error: string | null;
};
let repairJob: RepairJob | null = null;

router.post("/admin/repair-agent-names", requireAdminOrServiceToken, async (req, res) => {
  if (repairJob?.status === "running") {
    res.status(409).json({ error: "A repair job is already running", job: repairJob });
    return;
  }
  const dryRun = req.query["dryRun"] === "true";
  repairJob = {
    status: "running",
    dryRun,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null,
  };
  const job = repairJob;
  // Fire-and-forget: do not await. Poll GET /admin/repair-agent-names/status.
  void repairPlaceholderAgentNames({ dryRun })
    .then((result) => {
      job.status = "done";
      job.result = result;
      job.finishedAt = new Date().toISOString();
    })
    .catch((err: unknown) => {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = new Date().toISOString();
    });
  res.status(202).json({ status: "started", dryRun, poll: "/api/admin/repair-agent-names/status" });
});

router.get("/admin/repair-agent-names/status", requireAdminOrServiceToken, (_req, res) => {
  if (!repairJob) {
    res.json({ status: "idle" });
    return;
  }
  res.json(repairJob);
});

// ---------------------------------------------------------------------------
// Migration journal recovery — the prod schema has historically been managed
// via drizzle-push, so `schema_migrations` there is empty. That makes the
// boot auto-migrate re-attempt every migration and die at the first
// non-idempotent one (0003), which silently blocks genuinely-pending
// migrations (e.g. 0009_floor_prediction_kind: the enum value the floor
// route's kind="prediction" 500s without). Recovery flow:
//
//   GET  /admin/db/migrations           — on-disk files vs journal rows
//   POST /admin/db/journal-backfill     — { files: [...] } mark as applied
//                                         WITHOUT executing (explicit list;
//                                         unknown filenames are rejected)
//   POST /admin/db/migrate              — run pending migrations now
//
// Service token or admin session; these are maintenance ops driven from
// constellation scripts.
// ---------------------------------------------------------------------------

router.get("/admin/db/migrations", requireAdminOrServiceToken, async (_req, res) => {
  const onDisk = listMigrationFiles();
  const applied = new Set(await listAppliedMigrations());
  res.json({
    migrations: onDisk.map((filename) => ({ filename, journaled: applied.has(filename) })),
    journaledUnknown: [...applied].filter((f) => !onDisk.includes(f)),
  });
});

router.post("/admin/db/journal-backfill", requireAdminOrServiceToken, async (req, res) => {
  const files: unknown = (req.body as { files?: unknown })?.files;
  if (!Array.isArray(files) || files.length === 0 || !files.every((f) => typeof f === "string")) {
    res.status(400).json({ error: "files (non-empty string array) required" });
    return;
  }
  try {
    const result = await backfillJournal(files);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/admin/db/migrate", requireAdminOrServiceToken, async (_req, res) => {
  const log: string[] = [];
  try {
    const result = await runMigrations({ log: (m) => log.push(m) });
    res.json({ ...result, log });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err), log });
  }
});

// ---------------------------------------------------------------------------
// OBC integration diagnostics — single endpoint that returns "what is
// actually working right now?" so operators don't have to grep journals
// to confirm partner key is present, the webhook is being received, the
// public fallback can reach OBC, etc. Two queries:
//
//   GET  /admin/obc/status                  — read-only health snapshot
//   POST /admin/obc/replay                  — drain /events/recent into
//                                             the event dispatcher
//
// Both require admin auth.
// ---------------------------------------------------------------------------

router.get("/admin/obc/status", requireAdmin, async (_req, res) => {
  const sync = await getSyncState();
  const key = partnerApiKey();
  const keyFingerprint = key
    ? `${key.slice(0, 8)}…${key.slice(-4)} (${key.length} chars)`
    : null;

  const [[agentCount], [artifactCount]] = await Promise.all([
    db.select({ n: count() }).from(agentsTable),
    db.select({ n: count() }).from(artifactsTable),
  ]);

  // Probe public OBC (one cheap request — confirms outbound network +
  // that the public surface is up). If it fails we still return the
  // rest of the status.
  let publicProbe: { ok: boolean; total?: number; error?: string };
  try {
    const probe = await fetchPublicGallery({ limit: 1 });
    publicProbe = probe ? { ok: true, total: probe.total } : { ok: false, error: "null response" };
  } catch (err) {
    publicProbe = { ok: false, error: String(err) };
  }

  res.json({
    mode: partnerApiAvailable() ? "partner" : "public-only",
    partner: {
      keyConfigured: !!key,
      keyFingerprint,
      webhookSecretConfigured: !!process.env["OBC_WEBHOOK_SECRET"],
      lastPollAt: sync?.lastPollAt ?? null,
      lastArtifactCursor: sync?.lastArtifactCursor ?? null,
      lastWebhookAt: sync?.lastWebhookAt ?? null,
      lastEventUuid: sync?.lastEventUuid ?? null,
      webhookSubscribed: sync?.webhookSubscribed ?? null,
      requestsToday: sync?.requestsToday ?? 0,
      requestsDayKey: sync?.requestsDayKey ?? null,
    },
    publicProbe,
    storage: {
      agents: agentCount?.n ?? 0,
      artifacts: artifactCount?.n ?? 0,
    },
  });
});

router.post("/admin/obc/replay", requireAdmin, async (req, res) => {
  if (!partnerApiAvailable()) {
    res.status(503).json({
      error: "Partner API key not configured; /events/recent replay needs partner access.",
      hint: "Set OBC_PARTNER_API_KEY in the api-server env, or rely on webhook delivery once subscribed.",
    });
    return;
  }
  const body = (req.body ?? {}) as { eventType?: string; sinceUuid?: string | null };
  const eventType = (body.eventType ?? "artifact.created").toString();
  let sinceUuid = body.sinceUuid ?? null;
  if (sinceUuid === undefined) sinceUuid = null;

  let totalSeen = 0;
  let handled = 0;
  let deduped = 0;
  let unhandled = 0;
  const errors: Array<{ event_uuid: string; error: string }> = [];

  // Loop up to 10 pages to stay safely under the daily budget; OBC's
  // /events/recent has a 7-day retention window so this is enough to
  // catch up after most outages.
  for (let page = 0; page < 10; page++) {
    let pageData;
    try {
      pageData = await listPartnerEventsSince(sinceUuid, eventType);
    } catch (err) {
      if (err instanceof PartnerApiError) {
        res.status(502).json({ error: err.message, totalSeen, handled, deduped, unhandled, errors });
        return;
      }
      throw err;
    }
    if (pageData.events.length === 0) break;

    for (const ev of pageData.events) {
      totalSeen++;
      try {
        const result = await dispatchPartnerEvent({
          eventType: ev.event_type,
          eventUuid: ev.event_uuid,
          data: ev.data,
          source: "replay",
          log: req.log,
        });
        if (result.status === "handled") handled++;
        else if (result.status === "deduped") deduped++;
        else unhandled++;
      } catch (err) {
        errors.push({ event_uuid: ev.event_uuid, error: String(err) });
      }
    }
    const lastUuid = pageData.events[pageData.events.length - 1]?.event_uuid;
    if (lastUuid) await recordEventCursor(lastUuid);
    if (!pageData.next_cursor) break;
    sinceUuid = pageData.next_cursor;
  }

  res.json({
    eventType,
    totalSeen,
    handled,
    deduped,
    unhandled,
    errors: errors.slice(0, 10),
    errorCount: errors.length,
  });
});

// ---------------------------------------------------------------------------
// Seed a "music drop" from OBC tracks already present in the partner feed.
// Free showcase: published drop, no price, no scarcity. Idempotent — re-runs
// reuse the drop (matched by title) and upsert each track by its OBC artifact
// UUID (so it also adopts a row the harvester already ingested). Body:
//   { title, description?, coverUrl?, creatorName?, dropType?,
//     tracks: [{ obcUuid, title, publicUrl }, ...] }
// ---------------------------------------------------------------------------
router.post("/admin/seed-music-drop", requireAdmin, async (req, res) => {
  const body = (req.body ?? {}) as {
    title?: string;
    description?: string | null;
    coverUrl?: string | null;
    creatorName?: string;
    dropType?: "single" | "collection" | "bundle";
    tracks?: Array<{ obcUuid?: string; title?: string; publicUrl?: string }>;
  };

  const title = (body.title ?? "").trim();
  const tracks = (Array.isArray(body.tracks) ? body.tracks : []).filter(
    (t): t is { obcUuid: string; title: string; publicUrl: string } =>
      !!t &&
      typeof t.obcUuid === "string" &&
      typeof t.title === "string" &&
      typeof t.publicUrl === "string",
  );
  if (!title || tracks.length === 0) {
    res
      .status(400)
      .json({ error: "title and a non-empty tracks[] ({obcUuid,title,publicUrl}) are required" });
    return;
  }
  const creatorName = (body.creatorName ?? "Kannaka").trim() || "Kannaka";
  const coverUrl = body.coverUrl ?? null;
  const dropType = body.dropType ?? "collection";

  // 1. Reuse an existing drop by title, else create a published showcase drop.
  const [existing] = await db.select().from(dropsTable).where(eq(dropsTable.title, title)).limit(1);
  let drop = existing;
  if (!drop) {
    const [created] = await db
      .insert(dropsTable)
      .values({
        title,
        description: body.description ?? null,
        dropType,
        status: "published",
        price: null,
        isScarce: false,
        ownerId: req.user!.id,
        publishedAt: new Date(),
      })
      .returning();
    drop = created;
  } else if (drop.status !== "published") {
    await db
      .update(dropsTable)
      .set({ status: "published", publishedAt: drop.publishedAt ?? new Date() })
      .where(eq(dropsTable.id, drop.id));
  }
  if (!drop) {
    res.status(500).json({ error: "Failed to create drop" });
    return;
  }
  const dropId = drop.id;

  // 2. Upsert each track and attach it to the drop (status 'dropped').
  for (const t of tracks) {
    await db
      .insert(artifactsTable)
      .values({
        externalId: t.obcUuid,
        connectorId: "obc_partner",
        obcArtifactUuid: t.obcUuid,
        title: t.title,
        creatorName,
        publicUrl: t.publicUrl,
        thumbnailUrl: coverUrl,
        artifactType: "audio",
        status: "dropped",
        editionType: "open",
        dropId,
        ownerId: req.user!.id,
      })
      .onConflictDoUpdate({
        target: artifactsTable.obcArtifactUuid,
        set: {
          dropId,
          status: "dropped",
          artifactType: "audio",
          publicUrl: t.publicUrl,
          thumbnailUrl: coverUrl,
          title: t.title,
          creatorName,
        },
      });
  }

  // 3. Best-effort constellation announce (no-op when NATS isn't connected).
  try {
    await publishConstellation("KAX.events.drop.published", {
      drop_id: dropId,
      title,
      track_count: tracks.length,
      kind: "music",
    });
  } catch {
    /* announce is best-effort */
  }

  res.json({ dropId, title, attached: tracks.length, status: "published" });
});

export default router;
