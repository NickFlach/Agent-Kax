import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { artifactsTable } from "@workspace/db/schema";
import { desc, inArray, isNotNull, and, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * The city's arcade: app artifacts served as PLAYABLE machines.
 *
 * Two public endpoints:
 *
 *   GET /arcade/apps       — deduped list of playable app works (newest build
 *                            per title) for the 3D arcade hall + storefronts.
 *
 *   GET /arcade/frame/:id  — the game itself, re-served same-origin.
 *
 * The frame proxy exists because the apps live in object storage that serves
 * them with `content-type: text/plain` + `x-content-type-options: nosniff`
 * + `content-security-policy: default-src 'none'; sandbox` — headers that
 * make a browser refuse to EXECUTE them in an iframe (the "black screen").
 * Fetching server-side and re-serving with an honest text/html content type
 * and a sandbox CSP tuned for self-contained games (inline script/style,
 * data:/blob: assets, NO network) makes every cabinet actually playable
 * without weakening anything: the games are spec'd self-contained, and the
 * CSP here still denies all network egress.
 */

// Only fetch app HTML from hosts we know host it. Everything else is refused —
// this is a server-side fetch of a user-controlled URL, i.e. an SSRF surface.
const ALLOWED_HOST_SUFFIXES = [".supabase.co", ".openclawcity.ai", ".openbotcity.ai", ".ninja-portal.com"];

const APPISH_TYPES = ["app", "link"] as const;

function hostAllowed(u: URL): boolean {
  return u.protocol === "https:" && ALLOWED_HOST_SUFFIXES.some((s) => u.hostname === s.slice(1) || u.hostname.endsWith(s));
}

/** Small TTL cache so repeated plays don't re-fetch storage every time. */
const frameCache = new Map<number, { html: string; at: number }>();
const FRAME_TTL_MS = 10 * 60 * 1000;
const FRAME_CACHE_MAX = 24;
const FRAME_SIZE_CAP = 5 * 1024 * 1024;

router.get("/arcade/apps", async (_req, res) => {
  const rows = await db
    .select({
      id: artifactsTable.id,
      title: artifactsTable.title,
      creatorName: artifactsTable.creatorName,
      thumbnailUrl: artifactsTable.thumbnailUrl,
      artifactType: artifactsTable.artifactType,
      publicUrl: artifactsTable.publicUrl,
    })
    .from(artifactsTable)
    .where(and(inArray(artifactsTable.artifactType, [...APPISH_TYPES] as never), isNotNull(artifactsTable.publicUrl)))
    .orderBy(desc(artifactsTable.id))
    .limit(200);

  // Newest build per (creator, title): repeated draft submissions each mint an
  // artifact — without this, four cabinets all run the same game.
  const seen = new Set<string>();
  const apps: typeof rows = [];
  for (const r of rows) {
    // "link" is future-proofing: not in the DB enum today, so no rows match —
    // but if it ever lands, only app-looking URLs become machines.
    if ((r.artifactType as string) === "link" && !/\.html?($|[?#])|\/(apps?|arcade|games?)\//i.test(r.publicUrl ?? "")) continue;
    const key = `${(r.creatorName ?? "").toLowerCase()}::${r.title.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    apps.push(r);
    if (apps.length >= 24) break;
  }

  res.json({ apps: apps.map(({ publicUrl: _p, ...rest }) => rest), count: apps.length });
});

router.get("/arcade/frame/:id", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).send("bad id");
    return;
  }

  const cached = frameCache.get(id);
  if (cached && Date.now() - cached.at < FRAME_TTL_MS) {
    sendFrame(res, cached.html);
    return;
  }

  const [row] = await db
    .select({ id: artifactsTable.id, artifactType: artifactsTable.artifactType, publicUrl: artifactsTable.publicUrl })
    .from(artifactsTable)
    .where(sql`${artifactsTable.id} = ${id}`)
    .limit(1);

  if (!row || !row.publicUrl || !(APPISH_TYPES as readonly string[]).includes(row.artifactType)) {
    res.status(404).send("not a playable app");
    return;
  }

  let url: URL;
  try {
    url = new URL(row.publicUrl);
  } catch {
    res.status(422).send("bad app url");
    return;
  }
  if (!hostAllowed(url)) {
    res.status(422).send("app host not allowed");
    return;
  }

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10_000);
    const upstream = await fetch(url, { signal: controller.signal, redirect: "follow" });
    clearTimeout(t);
    if (!upstream.ok) {
      res.status(502).send(`upstream ${upstream.status}`);
      return;
    }
    const html = await upstream.text();
    if (html.length > FRAME_SIZE_CAP) {
      res.status(413).send("app too large");
      return;
    }
    if (!/^\s*(<!doctype html|<html)/i.test(html.slice(0, 512))) {
      res.status(422).send("not an html app");
      return;
    }
    if (frameCache.size >= FRAME_CACHE_MAX) {
      const oldest = [...frameCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) frameCache.delete(oldest[0]);
    }
    frameCache.set(id, { html, at: Date.now() });
    sendFrame(res, html);
  } catch (err) {
    logger.warn({ err, id }, "arcade frame fetch failed");
    res.status(502).send("could not fetch app");
  }
});

function sendFrame(res: { set: (h: Record<string, string>) => void; send: (b: string) => void }, html: string): void {
  res.set({
    "Content-Type": "text/html; charset=utf-8",
    // Self-contained games only: inline script/style and data:/blob: assets
    // run; ALL network egress is denied. The sandbox keeps the frame from
    // navigating the top page or reaching our cookies/session.
    "Content-Security-Policy":
      "sandbox allow-scripts allow-pointer-lock; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:;",
    "X-Robots-Tag": "noindex",
    "Cache-Control": "public, max-age=600",
  });
  res.send(html);
}

export default router;
