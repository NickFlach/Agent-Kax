#!/usr/bin/env node
/**
 * Stand a second agent in the city so multiplayer can actually be tested.
 *
 * Presence is keyed by principal, and you never see yourself — so opening two
 * tabs signed in as the same user proves nothing: it is one body, and each tab
 * reports an empty street. Testing needs a SECOND identity.
 *
 * This is that second identity. Give it an agent identity token and it walks a
 * slow circle in the chosen room, beating like a real client, so a human in the
 * browser can see a body with a nameplate and (optionally) hear it speak.
 *
 * Getting a token: sign in to KAX, then
 *   POST /api/auth/token  {"kind":"agent","botId":"<obc bot uuid>"}
 * with your session cookie. The response's `token` is what this wants.
 *
 * Usage:
 *   KAX_TOKEN=<token> node scripts/presence-probe.mjs [room] [--say "hello"]
 *   KAX_TOKEN=<token> KAX_BASE_URL=http://127.0.0.1:5199 node scripts/presence-probe.mjs city
 */

const BASE = process.env.KAX_BASE_URL || "https://kax.ninja-portal.com";
const TOKEN = process.env.KAX_TOKEN || "";
const room = process.argv[2]?.startsWith("--") ? "city" : (process.argv[2] || "city");
const sayIdx = process.argv.indexOf("--say");
const PHRASE = sayIdx > -1 ? process.argv[sayIdx + 1] : null;

if (!TOKEN) {
  console.error("KAX_TOKEN required — an agent identity token.\n" +
    "Sign in to KAX, then POST /api/auth/token {\"kind\":\"agent\",\"botId\":\"<uuid>\"} with your session cookie.");
  process.exit(2);
}

const auth = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text for the error */ }
  return { status: res.status, json, text };
}

// A slow circle near the district entrance, so the body is easy to walk up to.
const CENTRE = { x: 0, z: 0 };
const RADIUS = 6;
let tick = 0;
let since = 0;

console.log(`probe: ${BASE} · room "${room}"`);

const first = await post("/api/presence/beat", { room, x: CENTRE.x, z: CENTRE.z, yaw: 0, since });
if (first.status !== 200) {
  // Exit by setting the code rather than calling process.exit(): killing the
  // process while a fetch handle is still open makes libuv assert on Windows,
  // which turns a correct refusal into something that looks like a crash.
  console.error(
    first.status === 401
      ? `refused: ${first.json?.error ?? first.text.slice(0, 140)}`
      : `unexpected ${first.status}: ${first.text.slice(0, 200)}`,
  );
  process.exitCode = 1;
}
if (process.exitCode !== 1) {
console.log(`standing as ${first.json.you.name} (${first.json.you.principal})`);
console.log("walking a slow circle — open the city in a browser and look for the nameplate. Ctrl-C to leave.\n");

if (PHRASE) {
  const r = await post("/api/chat/say", { room, text: PHRASE, x: CENTRE.x, z: CENTRE.z });
  console.log(r.status === 201 ? `said: "${PHRASE}"` : `could not speak: ${r.json?.error ?? r.status}`);
}

const timer = setInterval(async () => {
  tick++;
  const a = (tick / 40) * Math.PI * 2;
  const x = CENTRE.x + Math.cos(a) * RADIUS;
  const z = CENTRE.z + Math.sin(a) * RADIUS;
  const r = await post("/api/presence/beat", { room, x, z, yaw: -a, since });
  if (r.status !== 200) { console.log(`beat failed ${r.status}`); return; }

  for (const m of r.json.messages ?? []) {
    since = Math.max(since, m.id);
    console.log(`  heard ${m.name}: ${m.text}`);
  }
  const others = r.json.others ?? [];
  if (tick % 5 === 0) {
    console.log(others.length
      ? `  ${others.length} nearby: ${others.map((o) => o.name).join(", ")}`
      : "  nobody else here yet");
  }
}, 900);

async function leave() {
  clearInterval(timer);
  await post("/api/presence/leave", {}).catch(() => {});
  console.log("\nleft the city.");
  process.exit(0);
}
process.on("SIGINT", leave);
process.on("SIGTERM", leave);
}
