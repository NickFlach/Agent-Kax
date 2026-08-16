import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, runMigrations, listMigrationFiles, listAppliedMigrations, backfillJournal, unmarkJournal } from "@workspace/db";
import {
  usersTable,
  agentsTable,
  artifactsTable,
  dropsTable,
  commerceOrdersTable,
  commerceProductsTable,
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
  recordEventCursor,
  PartnerApiError,
} from "../lib/partnerClient";
import { fetchPublicGallery } from "../lib/publicClient";
import { dispatchPartnerEvent } from "../lib/eventDispatcher";
import { publish as publishConstellation } from "../lib/constellationBridge";
import {
  addressToFromSnapshot,
  getUncachablePrintifyClient,
  printifyEnabled,
  PrintifyError,
  PrintifyNotConfiguredError,
  type PrintifyClient,
} from "../lib/printifyClient";

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
// found by name in Printify rather than guessed at.
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

router.post("/admin/commerce-orders/:id/submit", requirePrintifyEnabled, requireAdmin, async (req, res) => {
  const printify = printifyForRequest(res);
  if (!printify) return;
  const id = parseCommerceOrderId(req.params["id"], res);
  if (id === null) return;

  try {
    const outcome = await db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(commerceOrdersTable)
        .where(eq(commerceOrdersTable.id, id))
        .limit(1)
        .for("update");
      if (!order) return { kind: "not_found" } as const;

      // Already submitted: hand back the id we already have and call nothing.
      // This is the branch that makes a double-click, a retried deploy script
      // and a second operator all cost one print run.
      if (order.printifyOrderId) {
        return { kind: "already_submitted", order, printifyOrderId: order.printifyOrderId } as const;
      }

      if (order.status !== "paid") {
        return { kind: "not_paid", order } as const;
      }

      // The product is looked up by the SKU the order recorded, because the
      // order snapshots what was sold rather than pointing at a row that can be
      // repriced or re-wired afterwards. Only the print identifiers come from
      // here; no money does.
      const [product] = await tx
        .select({
          printifyProductId: commerceProductsTable.printifyProductId,
          printifyVariantId: commerceProductsTable.printifyVariantId,
        })
        .from(commerceProductsTable)
        .where(eq(commerceProductsTable.sku, order.sku))
        .limit(1);

      // `printify_variant_id` is varchar so that an opaque foreign key never
      // gets arithmetic done to it; Printify wants the number, so the
      // conversion happens here at the boundary and a value that is not one is
      // a product nobody can print rather than a `NaN` posted to a printer.
      const variantId = Number(product?.printifyVariantId);
      if (!product?.printifyProductId || !Number.isInteger(variantId) || variantId <= 0) {
        return { kind: "not_printable", order } as const;
      }

      const submitted = await printify.submitOrder({
        externalId: order.clientReference,
        label: order.clientReference,
        lineItems: [
          { product_id: product.printifyProductId, variant_id: variantId, quantity: 1 },
        ],
        addressTo: addressToFromSnapshot(order),
      });

      const now = new Date();
      await tx
        .update(commerceOrdersTable)
        .set({
          printifyOrderId: submitted.id,
          fulfillmentState: "submitted",
          submittedAt: now,
          updatedAt: now,
        })
        .where(eq(commerceOrdersTable.id, order.id));

      return { kind: "submitted", order, printifyOrderId: submitted.id, submittedAt: now } as const;
    });

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
    const outcome = await db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(commerceOrdersTable)
        .where(eq(commerceOrdersTable.id, id))
        .limit(1)
        .for("update");
      if (!order) return { kind: "not_found" } as const;

      if (order.releasedAt) {
        return { kind: "already_released", order } as const;
      }
      if (!order.printifyOrderId) {
        // Release is the second half of a two-step, and the first half has not
        // happened. Nothing to send to production, and inventing a submission
        // here would be the single-step flow this endpoint exists to avoid.
        return { kind: "not_submitted", order } as const;
      }

      const released = await printify.sendToProduction(order.printifyOrderId);

      const now = new Date();
      await tx
        .update(commerceOrdersTable)
        .set({
          fulfillmentState: "in_production",
          releasedAt: now,
          releaseActor: actor,
          updatedAt: now,
        })
        .where(eq(commerceOrdersTable.id, order.id));

      return { kind: "released", order, releasedAt: now, providerStatus: released.status } as const;
    });

    switch (outcome.kind) {
      case "not_found":
        res.status(404).json({ error: "No such commerce order", reason: "order_not_found" });
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
