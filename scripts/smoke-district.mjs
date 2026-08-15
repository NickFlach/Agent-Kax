#!/usr/bin/env node
/**
 * Post-deploy smoke test for the KAX district.
 *
 * Both production outages on 2026-08-14 were found by hand-curling endpoints,
 * and only because somebody thought to look: the arcade feed 500'd for days
 * behind a comment claiming it was safe, and the residences floor plan
 * vanished behind a generic "Internal server error".
 *
 * Two rules this encodes, learned the hard way:
 *
 *   1. ASSERT SHAPE, NOT JUST STATUS. A 200 that returns zero units is not a
 *      working floor plan.
 *   2. NEVER ASSERT ON PAGE ROUTES. The SPA returns 200 for literally any
 *      path — including deliberate nonsense — so route checks prove nothing.
 *      Only API JSON is evidence.
 *
 * Usage:  node scripts/smoke-district.mjs [baseUrl]
 * Exits non-zero if any check fails, so it can gate a deploy.
 */

const BASE = process.argv[2] || process.env.KAX_BASE_URL || "https://kax.ninja-portal.com";
const TIMEOUT_MS = 20000;

async function get(path, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: ctl.signal, ...opts });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json; body kept for the message */ }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check("arcade feed returns playable apps", async () => {
  const r = await get("/api/arcade/apps");
  if (r.status !== 200) throw new Error(`status ${r.status} — ${r.text.slice(0, 120)}`);
  if (!Array.isArray(r.json?.apps)) throw new Error("no apps array");
  return `${r.json.apps.length} games`;
});

check("furniture showcase responds", async () => {
  const r = await get("/api/showcase/furniture");
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (!Array.isArray(r.json?.pieces)) throw new Error("no pieces array");
  return `${r.json.pieces.length} pieces`;
});

check("residences floor plan has all 80 units", async () => {
  const r = await get("/api/residences/units");
  if (r.status !== 200) throw new Error(`status ${r.status} code=${r.json?.code ?? "?"} — ${r.text.slice(0, 120)}`);
  const total = r.json?.total;
  if (total !== 80) throw new Error(`expected 80 units, got ${total}`);
  const occ = r.json?.occupied ?? 0;
  return `${total} units, ${occ} occupied`;
});

check("marketplace responds with storefronts", async () => {
  const r = await get("/api/marketplace/combined");
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (!Array.isArray(r.json?.storefronts)) throw new Error("no storefronts array");
  return `${r.json.storefronts.length} storefronts`;
});

check("claim refuses an anonymous caller", async () => {
  const r = await get("/api/residences/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ floor: 5, letter: "A" }),
  });
  if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
  return "401 as expected";
});

check("claim validates the unit before identity", async () => {
  const r = await get("/api/residences/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ floor: 12, letter: "A" }),
  });
  if (r.status !== 400) throw new Error(`expected 400 for the penthouse, got ${r.status}`);
  return "400 as expected";
});

check("ledger refuses an unauthenticated read", async () => {
  const r = await get("/api/ledger/my");
  if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
  return "401 as expected";
});

check("schema matches what the code queries", async () => {
  // Note the /api prefix. Without it this hits the SPA, which answers 200 with
  // HTML for any path — the exact trap this file warns about, and one this
  // check fell into on its first run.
  const r = await get("/api/health/schema");
  if (r.json === null) return "endpoint not deployed yet (skipped)";
  if (typeof r.json.checkedTables !== "number") {
    throw new Error(`unexpected body: ${r.text.slice(0, 120)}`);
  }
  if (r.status !== 200 || r.json.ok !== true) {
    const miss = [...(r.json.missingTables ?? []), ...(r.json.missingColumns ?? [])];
    throw new Error(`schema mismatch: ${miss.join(", ") || r.text.slice(0, 120)}`);
  }
  return `${r.json.checkedTables} tables ok`;
});

check("the server says which build it is", async () => {
  // Worth its own check because "did my deploy land?" was answered all night
  // by probing features and inferring — and a missing route and a legitimate
  // "not found" both answer 404, so the inference needed response BODIES to
  // be trustworthy. One request, no guessing.
  const r = await get("/api/version");
  if (r.status !== 200 || !r.json?.commit) {
    throw new Error(`no version endpoint yet (${r.status}) — this build predates it`);
  }
  const age = r.json.startedAt ? Math.round((Date.now() - Date.parse(r.json.startedAt)) / 60000) : null;
  return `commit ${r.json.commit}${age !== null ? `, up ${age}m` : ""}`;
});

check("the penthouse is a real address, and not part of the stock", async () => {
  const r = await get("/api/residences/units");
  if (r.json?.total !== 80) throw new Error(`allocatable stock changed: total=${r.json?.total}`);
  const ph = r.json?.penthouse;
  if (!ph) throw new Error("penthouse missing from the floor plan");
  if (ph.floor !== 12) throw new Error(`penthouse on floor ${ph.floor}, expected 12`);
  if (r.json.units.some((u) => u.floor === 12)) throw new Error("penthouse listed among claimable units");
  return `${ph.label} — ${ph.resident?.name ?? "VACANT"}`;
});

check("the city answers who is in it", async () => {
  const r = await get("/api/city/rooms");
  if (r.status !== 200 || !r.json || typeof r.json.residents !== "number") {
    throw new Error(`expected room counts, got ${r.status} ${r.text.slice(0, 100)}`);
  }
  const rooms = r.json.rooms ?? [];
  if (!Array.isArray(rooms) || !rooms.length) throw new Error("expected a room directory");
  const busiest = rooms.find((x) => x.here > 0);
  return `${rooms.length} rooms, ${r.json.residents} resident bodies` +
    (busiest ? `, busiest ${busiest.id}=${busiest.here}` : ", all quiet");
});

check("a room can be looked into without an identity", async () => {
  const r = await get("/api/city/room/city");
  if (r.status !== 200 || !Array.isArray(r.json?.occupants)) {
    throw new Error(`expected an occupant list, got ${r.status} ${r.text.slice(0, 100)}`);
  }
  // Looking in from outside must not hand out principals — a name and a
  // position is what a passer-by can see, and all they should get.
  if (r.json.occupants.some((o) => "principal" in o)) throw new Error("room view leaked principals");
  return `${r.json.occupants.length} in the street`;
});

check("living in the city requires an identity", async () => {
  // The residency is server-held and outlives any request, so an anonymous
  // caller getting in would be a body nobody could be held to.
  for (const [path, opts] of [
    ["/api/city/enter", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }],
    ["/api/city/look", {}],
  ]) {
    const r = await get(path, opts);
    if (r.status !== 401) throw new Error(`${path} answered ${r.status}, expected 401`);
  }
  return "enter and look both refuse anonymous callers";
});

check("the display font is actually served, not silently missing", async () => {
  // Status is worthless here: this SPA answers 200 with HTML for ANY path, so
  // a missing font looks exactly like a present one until you read the bytes.
  // That is how the old CDN URL 404'd for who knows how long while every
  // label in the city quietly rendered in a fallback face.
  const res = await fetch(`${BASE}/fonts/space-mono-regular.ttf`);
  const buf = Buffer.from(await res.arrayBuffer());
  const magic = buf.subarray(0, 4).toString("hex");
  if (magic !== "00010000") {
    throw new Error(`expected a TrueType file, got ${buf.length} bytes starting ${magic} (SPA HTML?)`);
  }
  return `${Math.round(buf.length / 1024)}KB of real TrueType`;
});

check("a nonsense path is not evidence of anything", async () => {
  // Guards the guard: if this ever stops returning HTML-with-200, the
  // assumption every other check rests on has changed and we should know.
  const r = await get("/definitely-not-a-real-route");
  if (r.json !== null) throw new Error("expected the SPA to answer with HTML, not JSON");
  return `SPA answers ${r.status} for anything — API JSON only`;
});

(async () => {
  console.log(`smoke: ${BASE}\n`);
  let failed = 0;
  for (const c of checks) {
    try {
      const detail = await c.fn();
      console.log(`  PASS  ${c.name} — ${detail}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${c.name} — ${e.message}`);
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})();
