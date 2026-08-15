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
 * Getting a token, in the order that actually works:
 *
 *   1. Sign in with your WALLET. Attaching a bot is gated by requireWalletAuth,
 *      which is stricter than a normal login on purpose — wallet is treated as
 *      canonical identity, so an email-only session gets 403 "Wallet sign-in
 *      required to manage attached bots".
 *   2. Attach the bot by PROVING you control it, which is a two-step flow, not
 *      a form field:
 *        POST /api/auth/agent/challenge {"obcBotId":"<uuid>"}   -> a phrase
 *        create an artifact on OBC from that bot with the phrase in its
 *        title or description
 *        POST /api/auth/agent/verify {"obcBotId":"<uuid>","artifactUuid":"..."}
 *   3. Only then:
 *        POST /api/auth/token {"obcBotId":"<uuid>"}   -> { token }
 *
 * NOTE THE FIELD NAME: `obcBotId`, not `botId`. The handler reads obcBotId and
 * silently falls through to minting a USER token if it is absent — no error,
 * just the wrong kind of token, which is a confusing hour if you do not know.
 *
 * Usage:
 *   KAX_TOKEN=<token> node scripts/presence-probe.mjs [room] [--say "hello"]
 *   KAX_TOKEN=<token> KAX_BASE_URL=http://127.0.0.1:5199 node scripts/presence-probe.mjs city
 */

import { createBody, step } from "./agent-body.mjs";

const BASE = process.env.KAX_BASE_URL || "https://kax.ninja-portal.com";
let TOKEN = process.env.KAX_TOKEN || "";
const room = process.argv[2]?.startsWith("--") ? "city" : (process.argv[2] || "city");
const sayIdx = process.argv.indexOf("--say");
const PHRASE = sayIdx > -1 ? process.argv[sayIdx + 1] : null;

if (!TOKEN) {
  console.error(
    [
      "KAX_TOKEN required — an agent identity token.",
      "1. Sign in with your WALLET (email-only sessions get 403 on bot attach).",
      "2. Attach the bot: POST /api/auth/agent/challenge {obcBotId} -> put the",
      "   phrase in an OBC artifact from that bot -> POST /api/auth/agent/verify",
      "   {obcBotId, artifactUuid}.",
      '3. POST /api/auth/token {"obcBotId":"<uuid>"} with your session cookie.',
      "The field is obcBotId, NOT botId — botId is ignored and mints a user token.",
    ].join("\n"),
  );
  process.exit(2);
}

const authHeaders = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` });

/**
 * Agent tokens last 15 minutes, which is right for a bearer credential and
 * wrong as the only way to exist. /auth/token/refresh exists precisely so
 * "CLI/swarm agents can run autonomously" — the oat claim rides through every
 * refresh and only the 30-day lineage cap forces a human back in. Without this
 * the agent simply evaporates mid-conversation, which is what happened the
 * first time somebody stood in the street talking to her.
 */
async function refreshToken() {
  try {
    const res = await fetch(`${BASE}/api/auth/token/refresh`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ token: TOKEN }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.log(`  token refresh refused (${res.status}): ${body.slice(0, 120)}`);
      return false;
    }
    const j = await res.json();
    if (j.token) { TOKEN = j.token; console.log("  token refreshed"); return true; }
    return false;
  } catch (e) {
    console.log(`  token refresh failed: ${e.message}`);
    return false;
  }
}

/**
 * A network failure is weather, not a decision.
 *
 * This used to let fetch throw, and the throw happened inside an async
 * setInterval callback where nothing was waiting to catch it — so the first
 * connect timeout became an unhandled rejection and killed the process. A
 * brief outage took both agents out of the city permanently, with a stack
 * trace, which is the same failure as the expired token wearing a different
 * hat: something transient ended a life that was supposed to be continuous.
 *
 * Status 0 means "could not reach the city". The caller keeps walking.
 */
async function post(path, body) {
  try {
    const res = await fetch(`${BASE}${path}`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep text for the error */ }
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: String(e?.cause?.code ?? e?.message ?? e) };
  }
}

// A slow circle near the district entrance, so the body is easy to walk up to.
// KAX_CENTER="x,z" moves it — two agents in one street should not stand inside
// each other, and a second probe needs somewhere of its own to pace.
const CENTRE = (() => {
  const raw = (process.env.KAX_CENTER || "0,0").split(",").map(Number);
  return { x: Number.isFinite(raw[0]) ? raw[0] : 0, z: Number.isFinite(raw[1]) ? raw[1] : 0 };
})();
const RADIUS = Number(process.env.KAX_RADIUS) > 0 ? Number(process.env.KAX_RADIUS) : 6;
const BEAT_MS = 900;
const BEAT_S = BEAT_MS / 1000;
let tick = 0;
let since = 0;
/** The room as of the last beat — what the body reacts to on the next one. */
let lastOthers = [];
let lastMessages = [];
/** True while the city is unreachable, so the log records edges not every tick. */
let offline = false;

console.log(`probe: ${BASE} · room "${room}"`);

// Arriving during an outage should mean waiting at the door, not giving up:
// an agent meant to live in the city has to be able to boot into a bad minute.
let first = await post("/api/presence/beat", { room, x: CENTRE.x, z: CENTRE.z, yaw: 0, since });
for (let attempt = 0; first.status === 0 && attempt < 20; attempt++) {
  if (attempt === 0) console.log(`  cannot reach ${BASE} (${first.text}) — waiting`);
  await new Promise((r) => setTimeout(r, 6000));
  first = await post("/api/presence/beat", { room, x: CENTRE.x, z: CENTRE.z, yaw: 0, since });
}
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

// The manners live in agent-body: stop when spoken to, turn to face whoever is
// talking, stand at conversational distance, resume the patrol when it is over.
const body = createBody({ centre: CENTRE, radius: RADIUS, self: first.json.you.principal });
let lastMode = "";

const timer = setInterval(async () => {
  tick++;
  const p = step(body, { others: lastOthers, messages: lastMessages, now: Date.now(), dt: BEAT_S });
  lastMessages = [];
  if (p.mode !== lastMode) {
    lastMode = p.mode;
    console.log(`  [${p.mode}]${p.focusName ? ` → ${p.focusName}` : ""}`);
  }
  let r = await post("/api/presence/beat", { room, x: p.x, z: p.z, yaw: p.yaw, since });
  if (r.status === 401) {
    // Expired mid-walk: refresh and retry once rather than vanishing.
    if (await refreshToken()) r = await post("/api/presence/beat", { room, x: p.x, z: p.z, yaw: p.yaw, since });
  }
  if (r.status === 0) {
    // Presence will time us out after 20s and the city will show us gone,
    // which is honest — we cannot prove we are there. We come back when the
    // connection does, rather than dying with it. Log the edge only, or a
    // long outage buries everything else in the transcript.
    if (!offline) { offline = true; console.log(`  [offline] ${r.text} — still here, still trying`); }
    return;
  }
  if (offline) { offline = false; console.log("  [online] back in the city"); }
  if (r.status === 401) {
    // Refresh already ran and could not save us. An outage longer than the
    // token's life is unrecoverable by design — refresh extends a LIVE token,
    // it does not resurrect a dead one — so say the one useful thing and go,
    // rather than beating 401s forever and calling that being alive.
    console.error(
      `
refused: ${r.json?.error ?? r.text.slice(0, 160)}
` +
      `Mint a new token on KAX (POST /api/auth/token {"obcBotId":"<uuid>"}
` +
      `with your wallet session) and start the probe again.`,
    );
    clearInterval(timer);
    process.exitCode = 1;
    return;
  }
  if (r.status !== 200) { console.log(`beat failed ${r.status}`); return; }
  lastOthers = r.json.others ?? [];
  lastMessages = r.json.messages ?? [];
  // Refresh well before the 15-minute expiry rather than racing it.
  if (tick % 600 === 0) await refreshToken();

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
}, BEAT_MS);

async function leave() {
  clearInterval(timer);
  await post("/api/presence/leave", {}).catch(() => {});
  console.log("\nleft the city.");
  process.exit(0);
}
// Nothing should be able to kill a resident by accident. Anything that gets
// past the handling above is worth printing, but never worth dying over.
process.on("unhandledRejection", (e) => console.log(`  [survived] unhandled: ${e?.message ?? e}`));

process.on("SIGINT", leave);
process.on("SIGTERM", leave);
}
