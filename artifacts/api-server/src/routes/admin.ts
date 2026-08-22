import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, runMigrations, listMigrationFiles, listAppliedMigrations, backfillJournal, unmarkJournal } from "@workspace/db";
import {
  usersTable,
  agentsTable,
  artifactsTable,
  dropsTable,
  commerceOrdersTable,
} from "@workspace/db/schema";
import { and, desc, eq, isNull, ne, sql, count } from "drizzle-orm";
import { requireAdmin, requireAdminOrServiceToken } from "../middlewares/requireAuth";
import { ListAdminUsersResponse, UpdateAdminUserBody, UpdateAdminUserParams } from "@workspace/api-zod";
import { reattributeArtifactsByCreator, repairPlaceholderAgentNames, repairUnknownAgents } from "../lib/backfill";
import {
  partnerApiAvailable,
  partnerApiKey,
  getSyncState,
  listPartnerEventsSince,
  PartnerApiError,
} from "../lib/partnerClient";
import { ReplayCursor } from "../lib/replayCursor";
import { fetchPublicGallery } from "../lib/publicClient";
import { dispatchPartnerEvent } from "../lib/eventDispatcher";
import { publish as publishConstellation } from "../lib/constellationBridge";
import {
  getUncachablePrintifyClient,
  printifyEnabled,
  PrintifyError,
  PrintifyNotConfiguredError,
  type PrintifyClient,
} from "../lib/printifyClient";
import {
  reconcileCommerceOrderSubmission,
  releaseCommerceOrder,
  submitCommerceOrder,
} from "../lib/commerceFulfillment";
import { isAmbiguousMarker } from "../lib/commerceFulfillmentWorker";

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

// Merge/rename agents minted under the literal "Unknown" name (feed items
// with no creator object): resolves each placeholder's real name by bot UUID,
// MERGES it into an existing same-name agent when one exists (the classic
// `clawdine` 41 / `unknown-<uuid6>` 900+ split), else renames in place.
// Idempotent; synchronous (one exact lookup per bot, seconds not minutes).
/**
 * One agent wearing two rows.
 *
 * GET  reports what a merge would do, and is the one to run first.
 * POST performs it; ?dryRun=true makes POST report instead.
 *
 * Read is separated from write here rather than following the dryRun-query
 * convention of its neighbours, because this operation deletes an agent row
 * and a typo in a query parameter should not be what stands between a report
 * and a deletion. The write defaults to a dry run and needs ?apply=true said
 * out loud — that guard, not the auth tier, is what makes the deletion
 * deliberate. Auth matches the sibling repairs (repair-unknown-agents,
 * repair-agent-names), which are also destructive-ish maintenance run from a
 * shell rather than a browser.
 */
router.get("/admin/split-identities", requireAdminOrServiceToken, async (_req, res) => {
  const { findSplitIdentities } = await import("../lib/agentIdentity");
  const splits = await findSplitIdentities();
  res.json({ splits, count: splits.length });
});

router.post("/admin/merge-split-identities", requireAdminOrServiceToken, async (req, res) => {
  const { mergeSplitIdentities } = await import("../lib/agentIdentity");
  // Default is dry run. Merging identities is irreversible and the caller has
  // to say so out loud.
  const result = await mergeSplitIdentities({ dryRun: req.query["apply"] !== "true" });
  res.json(result);
});

router.post("/admin/repair-unknown-agents", requireAdminOrServiceToken, async (_req, res) => {
  const result = await repairUnknownAgents();
  res.json(result);
});

/**
 * The autonomy kill switch, write side (#403, ADR-0003 D6). One operator call
 * halts (or resumes) ALL autonomous execution fleet-wide. Deliberately NOT a
 * revocation: nobody loses their identity or their home. Body:
 *   { "halted": true, "reason": "why" }   — halt
 *   { "halted": false }                    — resume
 */
router.post("/admin/autonomy", requireAdminOrServiceToken, async (req, res) => {
  const { setAutonomyHalt } = await import("../lib/autonomy");
  const body = (req.body ?? {}) as { halted?: unknown; reason?: unknown };
  if (typeof body.halted !== "boolean") {
    res.status(400).json({ error: "body.halted must be a boolean" });
    return;
  }
  const by = req.user?.id ? `user:${req.user.id}` : "service-token";
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;
  res.json(await setAutonomyHalt(body.halted, reason, by));
});

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

// Inverse of journal-backfill: forget journal rows whose migration never
// actually executed (over-backfilled journal), so /admin/db/migrate can
// re-run them. Only for idempotent migrations; explicit list required.
router.post("/admin/db/journal-unmark", requireAdminOrServiceToken, async (req, res) => {
  const files: unknown = (req.body as { files?: unknown })?.files;
  if (!Array.isArray(files) || files.length === 0 || !files.every((f) => typeof f === "string")) {
    res.status(400).json({ error: "files (non-empty string array) required" });
    return;
  }
  try {
    const result = await unmarkJournal(files);
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
  let deferredCount = 0;
  const errors: Array<{ event_uuid: string; error: string }> = [];

  // The SAME deferral discipline the startup replay uses (#418) — a deferred
  // event freezes the run's cursor so its own pagination does not skip it —
  // but NON-PERSISTING. This is an operator catch-up from a caller-supplied
  // position; the startup replay owns the authoritative per-type cursor, and
  // persisting from an arbitrary `sinceUuid` could advance eventCursors[type]
  // past a startup-held deferral (or regress it). Dispatch stays idempotent
  // via processed_events, so a non-persisting replay is safe to re-run.
  const rc = new ReplayCursor(sinceUuid, eventType, /* persist */ false);

  // Loop up to 10 pages to stay safely under the daily budget; OBC's
  // /events/recent has a 7-day retention window so this is enough to
  // catch up after most outages.
  for (let page = 0; page < 10; page++) {
    let pageData;
    try {
      pageData = await listPartnerEventsSince(rc.fetchFrom(), eventType);
    } catch (err) {
      if (err instanceof PartnerApiError) {
        res.status(502).json({ error: err.message, totalSeen, handled, deduped, unhandled, deferred: deferredCount, errors });
        return;
      }
      throw err;
    }
    if (pageData.events.length === 0) break;

    for (const ev of pageData.events) {
      totalSeen++;
      let result;
      try {
        result = await dispatchPartnerEvent({
          eventType: ev.event_type,
          eventUuid: ev.event_uuid,
          data: ev.data,
          source: "replay",
          log: req.log,
        });
      } catch (err) {
        errors.push({ event_uuid: ev.event_uuid, error: String(err) });
        await rc.onFailed(ev.event_uuid);
        continue;
      }
      if (result.status === "deferred") {
        deferredCount++;
        await rc.onDeferred();
      } else {
        await rc.onProcessed(ev.event_uuid);
        if (result.status === "handled") handled++;
        else if (result.status === "deduped") deduped++;
        else unhandled++;
      }
    }
    if (!pageData.next_cursor) break;
    await rc.onPageBoundary(pageData.next_cursor);
  }

  res.json({
    eventType,
    totalSeen,
    handled,
    deduped,
    unhandled,
    deferred: deferredCount,
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

// ---------------------------------------------------------------------------
// Physical-commerce fulfilment (#287)
//
//   POST /admin/commerce-orders/:id/submit    — create the order at Printify
//   POST /admin/commerce-orders/:id/release   — send it to production
//
// Two steps and not one, because the shop's order approval is manual and that
// is a feature rather than an obstacle: between them sits the window in which a
// human's eyeballs are simultaneously the address-validation backstop and the
// fraud check, which is what makes shipping v0.1 without an address-validation
// service a decision rather than an omission.
//
// CHARGE FIRST, THEN SUBMIT, ALWAYS. `submit` refuses anything whose `status`
// is not `paid`, and the asymmetry is the reason: a Stripe refund is one API
// call, and unwinding a submitted print order is not. Printify also charges the
// merchant's own card at submission, so submitting ahead of capture means
// paying for manufacturing on an order that may never be paid for.
//
// That gate is read under the row lock, so it judges the status as it is at the
// moment of the press rather than as it was when the operator opened the page —
// which is what makes `refunded` and `chargeback` protective rather than
// decorative. `webhooks.ts` writes both off `charge.refunded` and
// `charge.dispute.*`; before it did, an order whose money had already gone back
// still read `paid` and was still submittable, and pressing submit meant paying
// a manufacturer to ship a parcel against a refunded charge.
//
// Both steps are idempotent no-ops when they have already happened, decided
// under `SELECT … FOR UPDATE` on the order row. `printify_order_id IS NOT NULL`
// is the double-submit guard and `released_at IS NOT NULL` the double-release
// guard; the lock is what makes two operators pressing the same button at the
// same moment produce one parcel instead of two. The provider call happens
// inside that lock deliberately — a second press waits for the first one's
// answer rather than racing it — and `external_id` carries the order's
// `client_reference` so that even a submission whose response was lost can be
// found by name in Printify rather than guessed at. Printify echoes that value
// back as `metadata.shop_order_label` and not as a top-level `external_id`,
// which is what `findOrderByExternalId` matches on.
//
// Those guards protect against a SECOND submission from this database. They say
// nothing about an order that reached Printify while the row that would have
// recorded it did not survive the request — so `submit` reconciles against
// Printify before it posts, exactly as the worker does. See the handler.
//
// Nothing here returns or logs a `ship_to_*` column. The address leaves this
// server exactly once, addressed to the printer, built by
// `addressToFromSnapshot` from the order's own snapshot and never from a live
// `users` or `user_shipping_addresses` join — an address edit after the fact
// must not be able to rewrite where an already-shipped parcel went.
// ---------------------------------------------------------------------------

/**
 * 404 with the flag off, exactly as if these routes were never mounted — the
 * inert-until-configured idiom the whole commerce surface uses.
 *
 * It runs BEFORE `requireAdmin` on purpose. A 401 from an unconfigured
 * deployment would still be an answer about a route that is supposed not to
 * exist yet, and "not mounted" is what this is meant to look like from outside.
 */
function requirePrintifyEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!printifyEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

/**
 * The adapter for this request, or the reason there isn't one.
 *
 * 503 when the flag is on but the token or the shop id is missing: that is a
 * fact about the deployment rather than about the order, and it must never be
 * resolved by looking up "the first shop the account has".
 */
function printifyForRequest(res: Response): PrintifyClient | null {
  try {
    return getUncachablePrintifyClient();
  } catch (err) {
    if (err instanceof PrintifyNotConfiguredError) {
      res.status(503).json({ error: err.message, reason: "printify_not_configured" });
      return null;
    }
    throw err;
  }
}

function parseCommerceOrderId(raw: unknown, res: Response): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid commerce order id" });
    return null;
  }
  return id;
}

/**
 * Report a provider refusal, or say that this was not one.
 *
 * 502: the request was well-formed and our side is intact; the manufacturer
 * said no. Only the status and Printify's numeric code cross the boundary —
 * `printifyClient.ts` has already dropped the field-level detail, which on a
 * rejected address is the buyer's street.
 */
function reportPrintifyFailure(res: Response, err: unknown): boolean {
  if (!(err instanceof PrintifyError)) return false;
  res.status(502).json({
    error: err.message,
    reason: "printify_refused",
    printifyStatus: err.status,
    printifyCode: err.code,
  });
  return true;
}

/** Newest first, and never the whole table. */
const COMMERCE_ORDER_LIST_DEFAULT_LIMIT = 50;
const COMMERCE_ORDER_LIST_MAX_LIMIT = 200;

/**
 * The listing behind both fulfilment paths.
 *
 * Until this existed there was no way to find an order to press submit on
 * except to know its id already, which made the manual path close to unusable
 * and would have made the automatic one unobservable — a worker whose retries,
 * backoff and parked orders can only be read out of a log is a worker nobody
 * can answer "did that order ship?" about.
 *
 * **The `ship_to_*` columns are not in the projection, and that is the point.**
 * The fields are selected by name rather than filtered out of a `SELECT *`,
 * because those are not the same guarantee: a stripping step is one refactor
 * away from being incomplete, whereas a column that was never asked for cannot
 * be forgotten about. The buyer's address leaves this server exactly once,
 * addressed to the printer. It does not leave it again because a listing page
 * found it convenient, and it is not in this response even for an admin — an
 * operator who genuinely needs to read an address has Printify's own UI, where
 * the parcel it belongs to is.
 *
 * `status` and `fulfillment_state` are compared as the varchars they are, so an
 * unrecognised filter value returns nothing rather than raising — the reason
 * neither column is a pgEnum.
 */
router.get("/admin/commerce-orders", requireAdmin, async (req, res) => {
  const status = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
  const fulfillmentState =
    typeof req.query["fulfillmentState"] === "string" ? req.query["fulfillmentState"] : undefined;

  const requested = Number(req.query["limit"]);
  const limit =
    Number.isInteger(requested) && requested > 0
      ? Math.min(requested, COMMERCE_ORDER_LIST_MAX_LIMIT)
      : COMMERCE_ORDER_LIST_DEFAULT_LIMIT;

  const filters = [
    status !== undefined ? eq(commerceOrdersTable.status, status) : undefined,
    fulfillmentState !== undefined
      ? eq(commerceOrdersTable.fulfillmentState, fulfillmentState)
      : undefined,
  ].filter((f) => f !== undefined);

  const orders = await db
    .select({
      id: commerceOrdersTable.id,
      clientReference: commerceOrdersTable.clientReference,
      buyerUserId: commerceOrdersTable.buyerUserId,
      sku: commerceOrdersTable.sku,
      currency: commerceOrdersTable.currency,
      itemCents: commerceOrdersTable.itemCents,
      shippingCents: commerceOrdersTable.shippingCents,
      taxCents: commerceOrdersTable.taxCents,
      totalCents: commerceOrdersTable.totalCents,
      status: commerceOrdersTable.status,
      fulfillmentState: commerceOrdersTable.fulfillmentState,
      printifyOrderId: commerceOrdersTable.printifyOrderId,
      submittedAt: commerceOrdersTable.submittedAt,
      releasedAt: commerceOrdersTable.releasedAt,
      releaseActor: commerceOrdersTable.releaseActor,
      fulfillmentAttempts: commerceOrdersTable.fulfillmentAttempts,
      fulfillmentLastError: commerceOrdersTable.fulfillmentLastError,
      fulfillmentLastAttemptAt: commerceOrdersTable.fulfillmentLastAttemptAt,
      fulfillmentNextAttemptAt: commerceOrdersTable.fulfillmentNextAttemptAt,
      // The provider's own words and the poller's own clock. These are the
      // operator's half of the stage timeline and they are what the buyer's
      // half is deliberately built WITHOUT: `fulfillment_last_error` is
      // "429:8251" and `provider_status` is `in-production`, and neither is a
      // sentence anybody outside this page should be shown.
      //
      // `fulfillmentSyncedAt` is the one to read when the answer to "why has
      // this not moved" might be "nothing has looked at it". A worker failing
      // silently once a minute reads exactly like a worker that was never
      // switched on; a stale stamp here says which.
      providerStatus: commerceOrdersTable.providerStatus,
      providerStatusAt: commerceOrdersTable.providerStatusAt,
      shippedAt: commerceOrdersTable.shippedAt,
      deliveredAt: commerceOrdersTable.deliveredAt,
      trackingCarrier: commerceOrdersTable.trackingCarrier,
      trackingNumber: commerceOrdersTable.trackingNumber,
      trackingUrl: commerceOrdersTable.trackingUrl,
      fulfillmentSyncedAt: commerceOrdersTable.fulfillmentSyncedAt,
      createdAt: commerceOrdersTable.createdAt,
      updatedAt: commerceOrdersTable.updatedAt,
    })
    .from(commerceOrdersTable)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(commerceOrdersTable.id))
    .limit(limit);

  res.json({ orders, limit });
});

/**
 * Did the operator say, in the request, that they know what they are risking?
 *
 * Nothing is inferred from a truthy string or a `1`: an acknowledgement that a
 * second parcel may be printed is worth having only if it was deliberate, and
 * `"false"` is truthy.
 */
function acknowledgesDuplicateRisk(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { acknowledgeDuplicateRisk?: unknown }).acknowledgeDuplicateRisk === true
  );
}

/**
 * The two facts that decide whether this request could end in a POST, plus the
 * marker used to explain a refusal.
 *
 * Read WITHOUT a lock and used only to decide whether to spend a lookup: every
 * decision that matters is made again under `FOR UPDATE` inside
 * `submitCommerceOrder`, which is where a row that changed underneath us is
 * caught. Its purpose is to keep the reconcile off the paths that cannot post —
 * an unpaid order, a missing row, one that already has an id — so that pressing
 * submit on an order that was never going to be manufactured still reaches
 * Printify not at all.
 *
 * `fulfillment_last_error` is read only to decide what to TELL the operator when
 * the lookup could not run. It is never used to decide whether to LOOK — see the
 * worker's header for why a marker cannot be trusted for that.
 */
async function readSubmitPreflight(
  orderId: number,
): Promise<{ mayPost: boolean; marker: string | null }> {
  const [row] = await db
    .select({
      status: commerceOrdersTable.status,
      printifyOrderId: commerceOrdersTable.printifyOrderId,
      fulfillmentLastError: commerceOrdersTable.fulfillmentLastError,
    })
    .from(commerceOrdersTable)
    .where(eq(commerceOrdersTable.id, orderId))
    .limit(1);
  return {
    mayPost: row !== undefined && row.status === "paid" && row.printifyOrderId === null,
    marker: row?.fulfillmentLastError ?? null,
  };
}

/**
 * Submit by hand — and ask Printify first, exactly as the worker does.
 *
 * This endpoint is where an order the worker could not resolve gets ROUTED to a
 * human: a row whose submission was ambiguous, or whose lookup kept failing,
 * parks and waits for this button. It posted blind — no lookup, no look at the
 * marker — which made the button the most likely place in the whole system to
 * print a second parcel, pressed by the one person who had been told the order
 * needed attention.
 *
 * The happy path is deliberately unchanged. A clean paid order reconciles to
 * `absent` and is submitted, with the same response body it has always had; the
 * manual route is the only path to a fulfilled order that has been proven in
 * production, and this must not be the change that breaks it. Two things are
 * new and both only fire when there is a real reason:
 *
 * - the order was ALREADY at Printify — adopted, `reconciled: true`, nothing
 *   posted;
 * - the lookup could not be completed AND the row says a submission may already
 *   exist — 409, so the operator decides rather than the network deciding for
 *   them. `{"acknowledgeDuplicateRisk": true}` presses on anyway, which is the
 *   escape hatch for an operator who has just looked at Printify's own UI.
 *
 * A lookup that fails on a row with nothing in doubt is NOT a 409: there is no
 * evidence of a prior submission, blind posting is what this endpoint has always
 * done in that state, and refusing would take the proven manual path away
 * whenever Printify's list endpoint was unwell.
 */
router.post("/admin/commerce-orders/:id/submit", requirePrintifyEnabled, requireAdmin, async (req, res) => {
  const printify = printifyForRequest(res);
  if (!printify) return;
  const id = parseCommerceOrderId(req.params["id"], res);
  if (id === null) return;

  let reconciled = false;
  try {
    const preflight = await readSubmitPreflight(id);
    try {
      // Only when this request could actually end in a POST. An order that is
      // not paid, not there, or already submitted is refused by
      // `submitCommerceOrder` without a provider call, and spending a lookup to
      // arrive at the same refusal would put outbound traffic on paths that had
      // none.
      if (preflight.mayPost) {
        const found = await reconcileCommerceOrderSubmission(db, printify, id);
        // `adopted` writes the id onto the row, so the submit below finds it and
        // returns `already_submitted` without calling Printify. That is the
        // whole mechanism: the parcel is not printed twice because there is
        // nothing left to post.
        if (found.kind === "adopted") reconciled = true;
      }
    } catch (err) {
      if (err instanceof PrintifyNotConfiguredError) throw err;
      if (!(err instanceof PrintifyError)) throw err;
      const marker = preflight.marker;
      if (isAmbiguousMarker(marker) && !acknowledgesDuplicateRisk(req.body)) {
        res.status(409).json({
          error:
            "This order may already exist at Printify and we could not check. " +
            "Look it up in Printify by the order's reference before submitting again.",
          reason: "reconcile_unavailable",
          fulfillmentLastError: marker,
          printifyStatus: err.status,
          printifyCode: err.code,
          // Named in the response so the operator does not have to find it in
          // a document to act on the refusal.
          acknowledgeWith: { acknowledgeDuplicateRisk: true },
        });
        return;
      }
    }

    // The row lock, the two guards, the `paid` precondition and the rollback
    // all live in `lib/commerceFulfillment.ts` now, because the automatic
    // worker presses the same button and a second copy of that reasoning is
    // the copy that eventually double-prints. This handler's whole remaining
    // job is turning an outcome into a status code.
    const outcome = await submitCommerceOrder(db, printify, id);

    switch (outcome.kind) {
      case "not_found":
        res.status(404).json({ error: "No such commerce order", reason: "order_not_found" });
        return;
      case "not_paid":
        res.status(409).json({
          error: "That order has not been paid for",
          reason: "not_paid",
          orderStatus: outcome.order.status,
        });
        return;
      case "not_printable":
        res.status(409).json({
          error: "That product has no Printify product and variant on file",
          reason: "product_not_printable",
          sku: outcome.order.sku,
        });
        return;
      case "already_submitted":
        res.json({
          orderId: outcome.order.id,
          orderRef: outcome.order.clientReference,
          shopId: printify.shopId,
          printifyOrderId: outcome.printifyOrderId,
          fulfillmentState: outcome.order.fulfillmentState,
          submittedAt: outcome.order.submittedAt,
          alreadySubmitted: true,
          // True only when THIS request found the order at Printify and adopted
          // it. An operator seeing this learns that the button they pressed did
          // not print anything, and why.
          reconciled,
        });
        return;
      case "submitted":
        res.json({
          orderId: outcome.order.id,
          orderRef: outcome.order.clientReference,
          shopId: printify.shopId,
          printifyOrderId: outcome.printifyOrderId,
          fulfillmentState: "submitted",
          submittedAt: outcome.submittedAt,
          alreadySubmitted: false,
          reconciled: false,
        });
        return;
    }
  } catch (err) {
    // A provider refusal rolls the transaction back, so an order Printify
    // rejected keeps its `unfulfilled` state and its null id and can simply be
    // submitted again once the reason is fixed.
    if (reportPrintifyFailure(res, err)) return;
    throw err;
  }
});

router.post("/admin/commerce-orders/:id/release", requirePrintifyEnabled, requireAdmin, async (req, res) => {
  const printify = printifyForRequest(res);
  if (!printify) return;
  const id = parseCommerceOrderId(req.params["id"], res);
  if (id === null) return;
  const actor = req.user!.id;

  try {
    const outcome = await releaseCommerceOrder(db, printify, id, actor);

    switch (outcome.kind) {
      case "not_found":
        res.status(404).json({ error: "No such commerce order", reason: "order_not_found" });
        return;
      case "not_paid":
        // 409 and the same `not_paid` reason submit answers with, because it is
        // the same refusal: the money is not there. Release had no such check
        // until now, which meant an order that had gone to `refunded` or
        // `chargeback` after submission could still be sent to production by
        // hand — the manual path had the hole the worker had, and pressing a
        // button is not a fact about whether the charge stuck.
        res.status(409).json({
          error: "That order has not been paid for",
          reason: "not_paid",
          orderStatus: outcome.order.status,
        });
        return;
      case "not_submitted":
        res.status(409).json({
          error: "That order has not been submitted to Printify yet",
          reason: "not_submitted",
        });
        return;
      case "already_released":
        res.json({
          orderId: outcome.order.id,
          orderRef: outcome.order.clientReference,
          printifyOrderId: outcome.order.printifyOrderId,
          fulfillmentState: outcome.order.fulfillmentState,
          releasedAt: outcome.order.releasedAt,
          releaseActor: outcome.order.releaseActor,
          alreadyReleased: true,
        });
        return;
      case "released":
        res.json({
          orderId: outcome.order.id,
          orderRef: outcome.order.clientReference,
          printifyOrderId: outcome.order.printifyOrderId,
          fulfillmentState: "in_production",
          releasedAt: outcome.releasedAt,
          releaseActor: actor,
          providerStatus: outcome.providerStatus,
          alreadyReleased: false,
        });
        return;
    }
  } catch (err) {
    if (reportPrintifyFailure(res, err)) return;
    throw err;
  }
});

export default router;
