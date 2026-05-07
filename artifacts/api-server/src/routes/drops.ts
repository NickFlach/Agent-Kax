import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { dropsTable, artifactsTable, activitiesTable } from "@workspace/db/schema";
import { eq, desc, and, count } from "drizzle-orm";
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
import { canMutate, requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

async function checkDropOwnership(req: any, res: any, dropId: number): Promise<boolean> {
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

async function getDropWithArtifacts(dropId: number) {
  const drop = await db.select().from(dropsTable).where(eq(dropsTable.id, dropId)).limit(1);
  if (drop.length === 0) return null;

  const artifacts = await db
    .select()
    .from(artifactsTable)
    .where(eq(artifactsTable.dropId, dropId))
    .orderBy(desc(artifactsTable.ingestedAt));

  return {
    ...drop[0],
    artifacts: artifacts.map(formatArtifact),
    createdAt: drop[0].createdAt.toISOString(),
    publishedAt: drop[0].publishedAt?.toISOString() ?? null,
  };
}

router.get("/drops", async (req, res) => {
  const query = ListDropsQueryParams.parse(req.query);
  const conditions = [];

  if (query.status) {
    conditions.push(eq(dropsTable.status, query.status));
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
  const [drop] = await db
    .insert(dropsTable)
    .values({
      title: body.title,
      description: body.description,
      dropType: body.dropType,
      price: body.price,
      ownerId: req.user!.id,
    })
    .returning();

  if (body.artifactIds && body.artifactIds.length > 0) {
    for (const artifactId of body.artifactIds) {
      const [a] = await db.select().from(artifactsTable).where(eq(artifactsTable.id, artifactId)).limit(1);
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
  const result = await getDropWithArtifacts(id);
  if (!result) {
    res.status(404).json({ error: "Drop not found" });
    return;
  }
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
  const { artifactId } = AddArtifactToDropBody.parse(req.body);

  const [a] = await db.select().from(artifactsTable).where(eq(artifactsTable.id, artifactId)).limit(1);
  if (!a || !(await canMutate(req, a.ownerId))) {
    res.status(403).json({ error: "Not authorized to use this artifact" });
    return;
  }

  await db
    .update(artifactsTable)
    .set({ dropId, status: "dropped" })
    .where(eq(artifactsTable.id, artifactId));

  await db.insert(activitiesTable).values({
    type: "dropped",
    message: `Artifact added to drop`,
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
