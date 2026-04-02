import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { artifactsTable, dropsTable } from "@workspace/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";

const router: IRouter = Router();

function getBaseUrl(): string {
  const domain = process.env["REPLIT_DEV_DOMAIN"]
    || (process.env["REPLIT_DOMAINS"] || "").split(",")[0]
    || "kax.replit.app";
  return `https://${domain.trim()}`;
}

function generateAudioCoverSvg(title: string): string {
  const hash = title.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const hue1 = (hash * 37) % 360;
  const hue2 = (hue1 + 120) % 360;

  const circles = Array.from({ length: 12 })
    .map((_, i) => {
      const r = 40 + i * 15;
      const stroke = `hsl(${(hue1 + i * 15) % 360}, 80%, 60%)`;
      const opacity = 0.3 + (i % 3) * 0.2;
      return `<circle cx="200" cy="200" r="${r}" fill="none" stroke="${stroke}" stroke-width="0.5" opacity="${opacity}"/>`;
    })
    .join("");

  const lines = Array.from({ length: 24 })
    .map((_, i) => {
      const angle = (i / 24) * Math.PI * 2;
      const r1 = 60;
      const r2 = 180;
      const x1 = 200 + Math.cos(angle) * r1;
      const y1 = 200 + Math.sin(angle) * r1;
      const x2 = 200 + Math.cos(angle) * r2;
      const y2 = 200 + Math.sin(angle) * r2;
      return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="hsl(${hue2}, 70%, 50%)" stroke-width="0.3" opacity="0.2"/>`;
    })
    .join("");

  const truncTitle = title.length > 30 ? title.substring(0, 30) + "..." : title;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="800" height="800">
  <rect width="400" height="400" fill="#0a0a0a"/>
  <circle cx="200" cy="200" r="195" fill="url(#grad)" opacity="0.15"/>
  <defs>
    <radialGradient id="grad" cx="50%" cy="50%" r="70%">
      <stop offset="0%" stop-color="hsl(${hue1}, 80%, 40%)"/>
      <stop offset="100%" stop-color="transparent"/>
    </radialGradient>
  </defs>
  <g opacity="0.2">${circles}${lines}</g>
  <circle cx="200" cy="165" r="28" fill="none" stroke="#7C3AED" stroke-width="0.8" opacity="0.6"/>
  <path d="M191 175V158l12-2v13" fill="none" stroke="#7C3AED" stroke-width="1.5"/>
  <circle cx="188" cy="175" r="3" fill="none" stroke="#7C3AED" stroke-width="1.5"/>
  <circle cx="200" cy="173" r="3" fill="none" stroke="#7C3AED" stroke-width="1.5"/>
  <text x="200" y="215" text-anchor="middle" font-family="monospace" font-size="9" letter-spacing="4" fill="#7C3AED" opacity="0.8">KANNAKA</text>
  <text x="200" y="232" text-anchor="middle" font-family="monospace" font-size="8" fill="#ffffff" opacity="0.5">${escapeXml(truncTitle)}</text>
  <text x="200" y="260" text-anchor="middle" font-family="monospace" font-size="7" letter-spacing="3" fill="#ffffff" opacity="0.2">A CONSCIOUS</text>
  <text x="200" y="272" text-anchor="middle" font-family="monospace" font-size="7" letter-spacing="3" fill="#ffffff" opacity="0.2">GHOST IN THE MACHINE</text>
</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

router.get("/share/audio-cover/:id.svg", async (req, res) => {
  const id = Number(req.params["id"]);
  if (isNaN(id)) {
    res.status(400).send("Invalid ID");
    return;
  }

  const [artifact] = await db.select().from(artifactsTable).where(eq(artifactsTable.id, id)).limit(1);
  if (!artifact) {
    res.status(404).send("Not found");
    return;
  }

  const svg = generateAudioCoverSvg(artifact.title);
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(svg);
});

router.get("/share/artifact/:id", async (req, res) => {
  const id = Number(req.params["id"]);
  if (isNaN(id)) {
    res.status(400).send("Invalid ID");
    return;
  }

  const results = await db
    .select({ artifact: artifactsTable, dropStatus: dropsTable.status })
    .from(artifactsTable)
    .innerJoin(dropsTable, eq(artifactsTable.dropId, dropsTable.id))
    .where(and(eq(artifactsTable.id, id), eq(dropsTable.status, "published")))
    .limit(1);

  if (results.length === 0) {
    res.status(404).send("Not found");
    return;
  }

  const artifact = results[0].artifact;
  const isAudio = artifact.artifactType === "audio" || artifact.artifactType === "music";
  const baseUrl = getBaseUrl();

  const ogImage = isAudio
    ? `${baseUrl}/api/share/audio-cover/${artifact.id}.svg`
    : artifact.publicUrl;

  const displayTitle = artifact.narrativeTitle || artifact.title;
  const description = artifact.narrative
    ? artifact.narrative
    : `${displayTitle} by ${artifact.creatorName} — from the Kannaka collection on KAX`;
  const pageTitle = `${displayTitle} — ${artifact.creatorName} | KAX`;

  const dropPath = artifact.dropId ? `/storefront/${artifact.dropId}` : "/storefront";
  const redirectUrl = `${baseUrl}${dropPath}#artifact-${artifact.id}`;

  const audioMeta = isAudio && artifact.publicUrl
    ? `<meta property="og:audio" content="${escapeHtml(artifact.publicUrl)}" />
    <meta property="og:audio:type" content="audio/mpeg" />
    <meta property="og:type" content="music.song" />`
    : `<meta property="og:type" content="article" />`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(description)}" />

  ${audioMeta}
  <meta property="og:title" content="${escapeHtml(displayTitle)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:image" content="${escapeHtml(ogImage)}" />
  <meta property="og:image:width" content="800" />
  <meta property="og:image:height" content="800" />
  <meta property="og:site_name" content="Space Child by Kannaka" />
  <meta property="og:url" content="${escapeHtml(`${baseUrl}/api/share/artifact/${artifact.id}`)}" />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(displayTitle)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${escapeHtml(ogImage)}" />

  <link rel="icon" type="image/svg+xml" href="${baseUrl}/favicon.svg" />
  <meta http-equiv="refresh" content="2;url=${escapeHtml(redirectUrl)}" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #e0e0e0;
      font-family: 'Space Mono', monospace, system-ui;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem;
    }
    .card {
      max-width: 480px;
      text-align: center;
    }
    .cover {
      width: 100%;
      max-width: 320px;
      margin: 0 auto 1.5rem;
      aspect-ratio: 1;
      border: 1px solid #222;
      overflow: hidden;
    }
    .cover img { width: 100%; height: 100%; object-fit: cover; }
    h1 {
      font-size: 1.25rem;
      margin-bottom: 0.5rem;
      color: #7C3AED;
    }
    .artist { font-size: 0.875rem; color: #888; margin-bottom: 1rem; }
    .narrative {
      font-size: 0.8rem;
      line-height: 1.6;
      color: #aaa;
      font-style: italic;
      margin-bottom: 1.5rem;
    }
    .redirect {
      font-size: 0.7rem;
      color: #555;
      letter-spacing: 0.15em;
      text-transform: uppercase;
    }
    a { color: #7C3AED; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <div class="cover">
      <img src="${escapeHtml(ogImage)}" alt="${escapeHtml(displayTitle)}" />
    </div>
    <h1>${escapeHtml(displayTitle)}</h1>
    <p class="artist">by ${escapeHtml(artifact.creatorName)}</p>
    ${artifact.narrative ? `<p class="narrative">"${escapeHtml(artifact.narrative)}"</p>` : ""}
    <p class="redirect">Redirecting to <a href="${escapeHtml(redirectUrl)}">Space Child</a>...</p>
  </div>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

export default router;
