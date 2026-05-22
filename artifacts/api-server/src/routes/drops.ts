import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { dropsTable, artifactsTable, activitiesTable } from "@workspace/db/schema";
import { eq, desc, and, count, inArray, sql } from "drizzle-orm";
import { formatArtifact } from "./artifacts";
import {
  ListDropsQueryParams,
  CreateDropBody,
  GetDropParams,
  UpdateDropParams,
  UpdateDropBody,
  DeleteDropParams,
  PublishDropParams,
  AddArtifactToDropParams,
  AddArtifactToDropBody,
  RemoveArtifactFromDropParams,
} from "@workspace/api-zod";
import { canMutate, requireAuth, getOwnerScope, getOptionalAuth } from "../middlewares/requireAuth";
import { isPublishableStatus } from "../lib/visibility";

const router: IRouter = Router();

async function checkDropOwnership(req: Request, res: Response, dropId: number): Promise<boolean> {
  const [drop] = await db.select().from(dropsTable).where(eq(dropsTable.id, dropId)).limit(1);
  if (!drop) {
    res.status(404).json({ error: "Drop not found" });
    return false;
  }
  if (!(await canMutate(req, drop.ownerId))) {
    res.status(403).json({ error: "Not authorized to modify this drop" });
    return false;
  }
  return true;
}

async function getDropWithArtifacts(dropId: number, opts: { publicOnly: boolean } = { publicOnly: false }) {
  const drop = await db.select().from(dropsTable).where(eq(dropsTable.id, dropId)).limit(1);
  if (drop.length === 0) return null;

  const artifacts = await db
    .select()
    .from(artifactsTable)
    .where(eq(artifactsTable.dropId, dropId))
    .orderBy(desc(artifactsTable.ingestedAt));

  // For public callers we keep only artifacts in a publishable status,
  // even when the drop itself is published. The private drop-mgmt route
  // can attach any owned artifact + stamps status='dropped'; without
  // this floor the public surface would expose raw / scored back-doors
  // (#9).
  const visibleArtifacts = opts.publicOnly
    ? artifacts.filter((a) => isPublishableStatus(a.status))
    : artifacts;

  return {
    ...drop[0],
    artifacts: visibleArtifacts.map(formatArtifact),
    createdAt: drop[0].createdAt.toISOString(),
    publishedAt: drop[0].publishedAt?.toISOString() ?? null,
  };
}

router.get("/drops/suggestions", requireAuth, async (req, res) => {
  const conditions = [
    inArray(artifactsTable.editionType, ["limited", "1_of_1"]),
    sql`${artifactsTable.dropId} IS NULL`,
    inArray(artifactsTable.status, ["scored", "narrated"]),
  ];
  if (req.user!.role !== "admin") {
    conditions.push(eq(artifactsTable.ownerId, req.user!.id));
  }
  const limited = await db
    .select()
    .from(artifactsTable)
    .where(and(...conditions))
    .orderBy(desc(artifactsTable.kannakaScore));

  const byCreator = new Map<string, typeof limited>();
  for (const a of limited) {
    const list = byCreator.get(a.creatorName) ?? [];
    list.push(a);
    byCreator.set(a.creatorName, list);
  }

  const suggestions = Array.from(byCreator.entries())
    .filter(([, items]) => items.length >= 2)
    .map(([creatorName, items]) => {
      const totalReactions = items.reduce((sum, a) => sum + a.reactionCount, 0);
      const scored = items.filter((a) => a.kannakaScore !== null);
      const averageScore = scored.length
        ? scored.reduce((s, a) => s + (a.kannakaScore ?? 0), 0) / scored.length
        : null;
      return {
        creatorName,
        artifactCount: items.length,
        totalReactions,
        averageScore: averageScore !== null ? Math.round(averageScore * 1000) / 1000 : null,
        artifacts: items.slice(0, 12).map(formatArtifact),
      };
    })
    .sort((a, b) => b.artifactCount - a.artifactCount);

  res.json({ suggestions });
});

router.get("/drops", requireAuth, async (req, res) => {
  const query = ListDropsQueryParams.parse(req.query);
  const conditions = [];

  if (query.status) {
    conditions.push(eq(dropsTable.status, query.status));
  }

  const ownerScope = await getOwnerScope(req);
  if (ownerScope !== null) {
    conditions.push(eq(dropsTable.ownerId, ownerScope));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [drops, totalResult] = await Promise.all([
    db
      .select()
      .from(dropsTable)
      .where(where)
      .orderBy(desc(dropsTable.createdAt))
      .limit(query.limit ?? 20)
      .offset(query.offset ?? 0),
    db.select({ count: count() }).from(dropsTable).where(where),
  ]);

  const dropsWithArtifacts = await Promise.all(
    drops.map(async (drop) => {
      const artifacts = await db
        .select()
        .from(artifactsTable)
        .where(eq(artifactsTable.dropId, drop.id));
      return {
        ...drop,
        artifacts: artifacts.map(formatArtifact),
        createdAt: drop.createdAt.toISOString(),
        publishedAt: drop.publishedAt?.toISOString() ?? null,
      };
    })
  );

  res.json({ drops: dropsWithArtifacts, total: totalResult[0].count });
});

router.post("/drops", requireAuth, async (req, res) => {
  const body = CreateDropBody.parse(req.body);
  const isScarce = body.isScarce ?? (body.dropType === "single" || body.dropType === "collection");
  const [drop] = await db
    .insert(dropsTable)
    .values({
      title: body.title,
      description: body.description,
      dropType: body.dropType,
      price: body.price,
      isScarce,
      ownerId: req.user!.id,
    })
    .returning();

  if (body.artifactIds && body.artifactIds.length > 0) {
    for (const artifactId of body.artifactIds) {
      const [a] = await db.select().from(artifactsTable).where(eq(artifactsTable.id, artifactId)).limit(1);
      if (a && isScarce && a.editionType === "open") {
        continue;
      }
      if (a && (await canMutate(req, a.ownerId))) {
        await db
          .update(artifactsTable)
          .set({ dropId: drop.id, status: "dropped" })
          .where(eq(artifactsTable.id, artifactId));
      }
    }
  }

  const result = await getDropWithArtifacts(drop.id);
  res.status(201).json(result);
});

router.get("/drops/:id", async (req, res) => {
  const { id } = GetDropParams.parse(req.params);
  // First fetch the drop alone to inspect status. Owners + admins can
  // see drafts; everyone else only sees published drops, and even then
  // only the publishable artifacts inside (#7, #9).
  const [draft] = await db.select().from(dropsTable).where(eq(dropsTable.id, id)).limit(1);
  if (!draft) {
    res.status(404).json({ error: "Drop not found" });
    return;
  }
  const auth = await getOptionalAuth(req);
  const isOwnerView = !!(auth && (auth.role === "admin" || draft.ownerId === auth.id));
  if (!isOwnerView && draft.status !== "published") {
    res.status(404).json({ error: "Drop not found" });
    return;
  }
  const result = await getDropWithArtifacts(id, { publicOnly: !isOwnerView });
  res.json(result);
});

router.patch("/drops/:id", requireAuth, async (req, res) => {
  const { id } = UpdateDropParams.parse(req.params);
  if (!(await checkDropOwnership(req, res, id))) return;
  const body = UpdateDropBody.parse(req.body);

  const updates: Record<string, unknown> = {};
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.price !== undefined) updates.price = body.price;
  if (body.status !== undefined) updates.status = body.status;
  if (body.isScarce !== undefined) updates.isScarce = body.isScarce;

  await db.update(dropsTable).set(updates).where(eq(dropsTable.id, id));

  const result = await getDropWithArtifacts(id);
  if (!result) {
    res.status(404).json({ error: "Drop not found" });
    return;
  }
  res.json(result);
});

router.delete("/drops/:id", requireAuth, async (req, res) => {
  const { id } = DeleteDropParams.parse(req.params);
  if (!(await checkDropOwnership(req, res, id))) return;
  await db
    .update(artifactsTable)
    .set({ dropId: null, status: "narrated" })
    .where(eq(artifactsTable.dropId, id));
  await db.delete(dropsTable).where(eq(dropsTable.id, id));
  res.status(204).send();
});

router.post("/drops/:id/publish", requireAuth, async (req, res) => {
  const { id } = PublishDropParams.parse(req.params);
  if (!(await checkDropOwnership(req, res, id))) return;

  await db
    .update(dropsTable)
    .set({ status: "published", publishedAt: new Date() })
    .where(eq(dropsTable.id, id));

  await db.insert(activitiesTable).values({
    type: "published",
    message: `Drop published`,
    ownerId: req.user!.id,
  });

  const result = await getDropWithArtifacts(id);
  if (!result) {
    res.status(404).json({ error: "Drop not found" });
    return;
  }
  res.json(result);
});

router.post("/drops/:dropId/artifacts", requireAuth, async (req, res) => {
  const { dropId } = AddArtifactToDropParams.parse(req.params);
  if (!(await checkDropOwnership(req, res, dropId))) return;
  const { artifactId, force } = AddArtifactToDropBody.parse(req.body);

  const [a] = await db.select().from(artifactsTable).where(eq(artifactsTable.id, artifactId)).limit(1);
  if (!a || !(await canMutate(req, a.ownerId))) {
    res.status(403).json({ error: "Not authorized to use this artifact" });
    return;
  }

  const [drop] = await db.select().from(dropsTable).where(eq(dropsTable.id, dropId)).limit(1);
  if (drop?.isScarce && a.editionType === "open" && !force) {
    res.status(409).json({
      error: `This drop is marketed as scarce; "${a.title}" is an open edition. Pass force=true to override.`,
    });
    return;
  }

  await db
    .update(artifactsTable)
    .set({ dropId, status: "dropped" })
    .where(eq(artifactsTable.id, artifactId));

  await db.insert(activitiesTable).values({
    type: "dropped",
    message: `Artifact added to drop`,
    ownerId: req.user!.id,
    agentId: a.agentId,
  });

  const result = await getDropWithArtifacts(dropId);
  if (!result) {
    res.status(404).json({ error: "Drop not found" });
    return;
  }
  res.json(result);
});

router.delete("/drops/:dropId/artifacts/:artifactId", requireAuth, async (req, res) => {
  const params = RemoveArtifactFromDropParams.parse(req.params);
  if (!(await checkDropOwnership(req, res, params.dropId))) return;

  await db
    .update(artifactsTable)
    .set({ dropId: null, status: "narrated" })
    .where(
      and(
        eq(artifactsTable.id, params.artifactId),
        eq(artifactsTable.dropId, params.dropId)
      )
    );

  res.status(204).send();
});

export default router;
