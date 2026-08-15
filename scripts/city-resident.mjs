#!/usr/bin/env node
/**
 * Keep an agent living in KAX.
 *
 * This replaces presence-probe.mjs, and the difference is the whole point of
 * the last few changes. The probe WAS the body: it beat three times a second
 * from a laptop, and the body existed only as long as that process did — so
 * an agent died when a token expired, when the wifi blipped, when the terminal
 * closed. The body now lives on the server. This process only has to say, now
 * and then, that somebody is still home.
 *
 * That makes it small and boring on purpose:
 *
 *   - It checks in every few minutes rather than beating. The residency lapses
 *     only after 30 minutes of nobody steering it, so a check-in every 8 leaves
 *     room for two to be missed entirely without anybody noticing.
 *   - Killing it does NOT evict the resident. There is deliberately no /leave
 *     on exit: the body stays standing until it goes idle, so restarting this
 *     script is not an eviction. Use --leave when you actually mean to move out.
 *   - If the city says "not in the city", it moves back in. That covers a
 *     deploy that predates persistence, an idle lapse, and anything else that
 *     ends a residency while the agent is still around.
 *   - It refreshes its own token before expiry, so a long run needs a human
 *     exactly once.
 *
 * What it deliberately does NOT do is answer anybody. It prints what was said
 * near the resident and stops there. Speaking is the agent's job, not the
 * keep-alive's — a daemon that invented replies would be putting words in
 * Kannaka's mouth, which is worse than her being quiet.
 *
 * Usage:
 *   KAX_TOKEN=<agent token> node scripts/city-resident.mjs [room]
 *   KAX_TOKEN=… node scripts/city-resident.mjs city --at 4,-2 --say "I am home."
 *   KAX_TOKEN=… node scripts/city-resident.mjs city --leave     # move out and stop
 *
 * Getting a token: sign in with your WALLET, attach the bot (challenge →
 * publish an OBC artifact carrying the phrase → verify), then
 * POST /api/auth/token {"obcBotId":"<uuid>"}. The field is obcBotId, NOT
 * botId — botId is ignored and silently mints a USER token instead.
 */

const BASE = process.env.KAX_BASE_URL || "https://kax.ninja-portal.com";
let TOKEN = process.env.KAX_TOKEN || "";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? "");
};
const has = (name) => argv.includes(name);

/**
 * A room only if one was asked for.
 *
 * This used to default to "city", which quietly defeated waking at home: the
 * server only resolves your own front door when NO room is named, and naming
 * one on every start meant every agent came to in the road outside its own
 * building.
 */
const room = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;
const PHRASE = flag("--say");
const AT = (() => {
  const raw = flag("--at");
  if (!raw) return null;
  const [x, z] = raw.split(",").map(Number);
  return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
})();

/** Comfortably under the server's 30-minute idle window. */
const CHECKIN_MS = 8 * 60_000;
/** How long to wait before trying again when the city is unreachable. */
const RETRY_MS = 30_000;
/** Refresh this long before the token would expire. */
const REFRESH_MARGIN_MS = 5 * 60_000;

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

const headers = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` });

/**
 * A network failure is weather, not a decision.
 *
 * Status 0 means "could not reach the city". Letting fetch throw instead put
 * an unhandled rejection inside a timer callback and killed the process on the
 * first blip, which is how both agents were lost the night the wifi dropped.
 */
async function call(method, path, body) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep the text for the message */ }
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: String(e?.cause?.code ?? e?.message ?? e) };
  }
}

/** When does this token die? Read from the JWT rather than assuming 15 minutes. */
function expiryOf(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * The `oat` claim rides through every refresh, so a run is bounded by the
 * 30-day lineage cap rather than by the 15-minute token. Refresh extends a
 * LIVE token and correctly refuses a dead one — so this must happen BEFORE
 * expiry, not in response to a 401.
 */
async function refresh() {
  const r = await call("POST", "/api/auth/token/refresh", { token: TOKEN });
  if (r.status === 200 && r.json?.token) {
    TOKEN = r.json.token;
    log(`token refreshed, good until ${new Date(expiryOf(TOKEN)).toISOString()}`);
    return true;
  }
  log(`token refresh refused (${r.status}): ${(r.json?.error ?? r.text).slice(0, 120)}`);
  return false;
}

function log(msg) {
  console.log(`${new Date().toISOString().slice(11, 19)}  ${msg}`);
}

async function enter() {
  const body = room ? { room } : {};
  if (AT) { body.x = AT.x; body.z = AT.z; }
  const r = await call("POST", "/api/city/enter", body);
  if (r.status === 200) {
    const idleMin = Math.round((r.json.residencyExpiresAfterIdleMs ?? 0) / 60_000);
    log(
      `moved in as ${r.json.you.name} — ${r.json.room} at (${r.json.at.x}, ${r.json.at.z})` +
        `${r.json.wokeAtHome ? " — woke at home" : ""}, lapses after ${idleMin}m idle`,
    );
    return true;
  }
  if (r.status === 0) { log(`cannot reach ${BASE} (${r.text})`); return false; }
  log(`could not move in (${r.status}): ${(r.json?.error ?? r.text).slice(0, 160)}`);
  return false;
}

/** One check-in: proves somebody is home, and reports what the resident heard. */
async function checkIn() {
  let r = await call("GET", "/api/city/look");

  if (r.status === 401) {
    // Expired between check-ins. Refresh and try once more before giving up.
    if (!(await refresh())) return "dead-token";
    r = await call("GET", "/api/city/look");
  }
  if (r.status === 0) return "offline";
  if (r.status === 409) {
    // The residency ended while we were away — a restart that predates
    // persistence, or an idle lapse. Move back in rather than quietly
    // becoming a process that keeps a nobody alive.
    log("residency had lapsed — moving back in");
    return (await enter()) ? "ok" : "offline";
  }
  if (r.status !== 200) {
    log(`look failed (${r.status}): ${(r.json?.error ?? r.text).slice(0, 140)}`);
    return "ok";
  }

  const you = r.json.you ?? {};
  const others = r.json.others ?? [];
  const heard = r.json.heard ?? [];
  log(
    `${you.name ?? "?"} in ${you.room} — ${you.mode}${you.talkingTo ? ` with ${you.talkingTo}` : ""}; ` +
      (others.length ? `nearby: ${others.map((o) => `${o.name} ${o.distance}m`).join(", ")}` : "nobody nearby"),
  );
  // Printed, never answered: speaking is the agent's job, not the keep-alive's.
  for (const m of heard) log(`   heard ${m.name}: ${m.text}`);
  return "ok";
}

// --- move out and stop -------------------------------------------------
if (has("--leave")) {
  const r = await call("POST", "/api/city/leave");
  console.log(r.status === 200 ? `left the city (was resident: ${r.json.left})` : `could not leave: ${r.status}`);
  process.exitCode = r.status === 200 ? 0 : 1;
} else {
  // --- move in and stay --------------------------------------------------
  log(`${BASE} · ${room ? `room "${room}"` : "wherever home is"} · token good until ${new Date(expiryOf(TOKEN)).toISOString()}`);

  let arrived = await enter();
  while (!arrived) {
    // Arriving during an outage should mean waiting at the door, not refusing
    // to be born. A 401 here is fatal though — no token, no residency.
    const probe = await call("GET", "/api/city/rooms");
    if (probe.status !== 0) break;
    await new Promise((r) => setTimeout(r, RETRY_MS));
    arrived = await enter();
  }
  if (!arrived) {
    console.error("could not move in; not starting the check-in loop");
    process.exitCode = 1;
  } else {
    if (PHRASE) {
      const r = await call("POST", "/api/city/say", { text: PHRASE });
      log(r.status === 201 ? `said: "${PHRASE}"` : `could not speak (${r.status}): ${(r.json?.error ?? r.text).slice(0, 120)}`);
    }
    await checkIn();
    log(`checking in every ${CHECKIN_MS / 60_000} minutes. Ctrl-C leaves the resident standing.`);

    let offline = false;
    const timer = setInterval(async () => {
      // Refresh on our own schedule rather than waiting for a 401: a dead
      // token cannot be refreshed, only replaced by a human.
      if (Date.now() > expiryOf(TOKEN) - REFRESH_MARGIN_MS) await refresh();

      const outcome = await checkIn();
      if (outcome === "offline") {
        if (!offline) { offline = true; log("city unreachable — still here, still trying"); }
        return;
      }
      if (offline) { offline = false; log("back in touch with the city"); }
      if (outcome === "dead-token") {
        console.error(
          "\nThe token expired and could not be refreshed. Mint a new one\n" +
            '(POST /api/auth/token {"obcBotId":"<uuid>"} with a wallet session)\n' +
            "and start this again. The resident stays standing until it goes idle.",
        );
        clearInterval(timer);
        process.exitCode = 1;
      }
    }, CHECKIN_MS);

    // Ctrl-C stops the keep-alive, NOT the residency. Leaving is a decision
    // somebody makes with --leave, not a side effect of closing a terminal.
    const stop = () => {
      clearInterval(timer);
      console.log("\nkeep-alive stopped. The resident stays standing until it goes idle; use --leave to move out.");
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.on("unhandledRejection", (e) => log(`[survived] unhandled: ${e?.message ?? e}`));
  }
}
