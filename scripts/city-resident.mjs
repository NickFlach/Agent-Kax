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
 * By default it does NOT answer anybody. It prints what was said near the
 * resident and stops there. Speaking is the agent's job, not the keep-alive's —
 * a daemon that invented replies would be putting words in Kannaka's mouth,
 * which is worse than her being quiet.
 *
 * `--voice` does not weaken that rule, it satisfies it. The daemon still
 * invents nothing: it hands what was heard to the agent's OWN HRM over NATS and
 * says back only what the agent answered. The words are hers; this process is
 * just the mouth. Without --voice, nothing about the old behaviour changes.
 *
 * It also has to be THIS process that speaks, not a companion script, because
 * `GET /city/look` DRAINS what was heard. Two pollers in one room silently eat
 * each other's messages, and the agent that was spoken to never sees it.
 *
 * Usage:
 *   KAX_TOKEN=<agent token> node scripts/city-resident.mjs [room]
 *   KAX_TOKEN=… node scripts/city-resident.mjs city --at 4,-2 --say "I am home."
 *   KAX_TOKEN=… node scripts/city-resident.mjs city --leave     # move out and stop
 *
 * To let the agent ANSWER, grounded in its own HRM (see VOICE below):
 *   NATS_USER=… NATS_PASSWORD=… KAX_TOKEN=… \
 *     node scripts/city-resident.mjs cafe --voice --agent-id 0xSCADA-QE
 *   …add --open-after 4 and it will also break a four-minute silence, which is
 *   what turns several residents in one room into a conversation.
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

/**
 * VOICE — opt in, never on by default.
 *
 * The keep-alive stays mute unless asked, and the original reason is unchanged:
 * a daemon that INVENTED replies would be putting words in an agent's mouth.
 * This does not invent anything. With --voice it asks the agent's own HRM over
 * NATS (`KANNAKA.ask.<agent-id>`) and says only what came back. The daemon is a
 * mouth; the mind is somewhere else and belongs to the agent.
 *
 * Two things upstream must be true, and both fail quietly:
 *   1. `kannaka swarm serve --agent-id <id>` is running for that agent.
 *      `swarm join` alone is NOT enough — its heartbeat advertises
 *      `capabilities.ask: true` whether or not anything is listening.
 *   2. That serve process had NATS_USER / NATS_PASSWORD in its environment.
 *      Without them it starts, prints "subscribing to KANNAKA.ask.<id>", looks
 *      healthy, and is deaf — the broker refused the subscription as ANONYMOUS.
 *
 * If nothing answers, the resident says so once and stays standing, silent.
 */
const VOICE = has("--voice");
const AGENT_ID = flag("--agent-id") || process.env.KANNAKA_AGENT_ID || "";
/** Minutes of silence before this resident opens a topic. 0 = only ever reply. */
const OPEN_AFTER_MS = Math.max(0, Number(flag("--open-after") ?? 0)) * 60_000;

import { nextRefreshAttempt } from "./lib/refresh-policy.mjs";
import { buildPrompt, fitToSay, shouldOpen, speechGate } from "./lib/voice-policy.mjs";

/** Comfortably under the server's 30-minute idle window. */
const CHECKIN_MS = 8 * 60_000;
/** How long to wait before trying again when the city is unreachable. */
const RETRY_MS = 30_000;
/**
 * Refresh this long before expiry — and it MUST exceed the check-in interval.
 *
 * This was a flat five minutes against an eight-minute tick, which opens a
 * three-minute hole the token can die in BETWEEN ticks. It duly did:
 *
 *   13:31:46  token refreshed, good until 13:46:47
 *   13:39:46  check-in (7m left, no refresh — margin not reached)
 *   13:47:46  refresh refused: expired 59 seconds ago
 *
 * A refreshed token lives ~15 minutes, so a margin smaller than the tick can
 * always be stepped over. Deriving it from the interval makes that impossible
 * by construction: refresh whenever the token would not comfortably survive
 * until the tick after next.
 */
const REFRESH_MARGIN_MS = CHECKIN_MS * 2;

/**
 * A talking resident has to listen far more often than a silent one.
 *
 * `look` DRAINS what was heard, so a reply can only ever be as fresh as the
 * poll that collected it: at the eight-minute keep-alive tick, an answer would
 * arrive up to eight minutes after the question. That is not a conversation.
 *
 * The margin above is deliberately NOT re-derived from this faster tick. It was
 * sized to be two ticks wide so a token can never expire in the gap between
 * check-ins; recomputing it as `VOICE_TICK_MS * 2` would quietly shrink a
 * sixteen-minute safety margin to thirty seconds and reintroduce exactly the
 * bug the comment above describes. Faster polling must never buy less headroom.
 */
const VOICE_TICK_MS = 15_000;
const TICK_MS = VOICE ? VOICE_TICK_MS : CHECKIN_MS;

/**
 * ...and a margin WIDER than the token itself is a refresh on EVERY tick.
 *
 * A refreshed token lives ~15 minutes and the margin above is 16, so "will it
 * survive two more ticks?" is always no, and the answer has always been to
 * refresh. At an eight-minute tick that is invisible: it just means refreshing
 * once per check-in, which is fine and is what has always happened. At the
 * fifteen-second voice tick it is four auth calls a minute per resident, and
 * three residents in a cafe made twelve. Observed doing exactly that:
 *
 *   04:35:58  token refreshed, good until 04:50:58
 *   04:36:14  token refreshed, good until 04:51:13
 *   04:36:29  token refreshed, good until 04:51:28
 *
 * So take the WIDER of "two ticks" and five minutes, and the original two-tick
 * rule keeps its exact meaning on the slow path — an 8-minute tick still yields
 * 16 minutes, unchanged. The voice path gets five: far more than two 15-second
 * ticks, and safely less than the life of a token, so it refreshes about every
 * ten minutes instead of continuously.
 */
const REFRESH_AT_MS = Math.max(TICK_MS * 2, Math.min(REFRESH_MARGIN_MS, 5 * 60_000));

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
  // Retry a TRANSPORT failure while the token is still alive, rather than
  // waiting for the next tick.
  //
  // Kannaka's body left the city because of that wait. One connect timeout at
  // 03:47, next attempt at the scheduled check-in 03:54:56, token dead at
  // 03:53:56 — seven minutes of valid token slept through, and after expiry
  // no refresh can ever succeed. 0xSCADA-QE ran the same code for hours and
  // never hit it, which is how this stayed invisible.
  //
  // A refusal is NOT retried: a 401 means the token is finished and asking
  // again only burns the remaining time and buries the message a human needs.
  for (let attempt = 0; ; attempt++) {
    const r = await call("POST", "/api/auth/token/refresh", { token: TOKEN });
    if (r.status === 200 && r.json?.token) {
      TOKEN = r.json.token;
      log(`token refreshed, good until ${new Date(expiryOf(TOKEN)).toISOString()}`);
      return true;
    }

    const detail = (r.json?.error ?? r.text).slice(0, 120);
    const plan = nextRefreshAttempt({ status: r.status, expiresAt: expiryOf(TOKEN), now: Date.now(), attempt });
    if (!plan.retry) {
      const why = plan.reason === "out-of-time" ? " — no token life left to retry" : "";
      log(`token refresh refused (${r.status}): ${detail}${why}`);
      return false;
    }
    log(`token refresh failed (${r.status}): ${detail} — retrying in ${Math.round(plan.delayMs / 1000)}s`);
    await new Promise((res) => setTimeout(res, plan.delayMs));
  }
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

// --- voice ---------------------------------------------------------------

/** A grounded recall over a few hundred memories is not a fast call. */
const ASK_TIMEOUT_MS = 45_000;
/** How long the resident holds its tongue after talking too much, too fast. */
const BURST_COOLDOWN_MS = 5 * 60_000;

/** Rolling room log, so that a reply is a reply and not a non-sequitur. */
const transcript = [];
const recentSays = [];
let lastSayAt = 0;
/** The last time ANYBODY spoke here — ours or overheard. Paces the room. */
let lastRoomSayAt = 0;
let cooldownUntil = 0;
/** True once we know nothing is answering for this agent. */
let mute = false;
let nats = null;
let codec = null;

async function openVoice() {
  if (!VOICE) return;
  if (!AGENT_ID) {
    console.error(
      "--voice needs --agent-id <swarm agent id> (or KANNAKA_AGENT_ID).\n" +
        "It is the id the agent joined the swarm under — `kannaka swarm status`\n" +
        "prints it, and it is case-sensitive.",
    );
    process.exit(2);
  }
  // Imported lazily so a silent resident needs no NATS client at all.
  const { connect, StringCodec } = await import("nats");
  nats = await connect({
    servers: process.env.KANNAKA_NATS_URL || "nats://swarm.ninja-portal.com:4222",
    user: process.env.NATS_USER,
    pass: process.env.NATS_PASSWORD,
    timeout: 10_000,
  });
  codec = StringCodec();
  log(`voice on — grounding in KANNAKA.ask.${AGENT_ID} via ${nats.getServer()}`);
}

/** Ask this agent's own mind. Returns null rather than throwing into a timer. */
async function askOwnMind(prompt) {
  try {
    const reply = await nats.request(
      `KANNAKA.ask.${AGENT_ID}`,
      codec.encode(JSON.stringify({ text: prompt })),
      { timeout: ASK_TIMEOUT_MS },
    );
    const answer = JSON.parse(codec.decode(reply.data));
    // A serve with no LLM provider configured answers, but with an error: it
    // can still do `recall`, and only `ask` needs a model.
    if (answer.error) {
      log(`HRM could not answer: ${String(answer.error).slice(0, 140)}`);
      return null;
    }
    if (mute) { mute = false; log("HRM is answering again"); }
    return answer.text || null;
  } catch (e) {
    if (!mute) {
      mute = true;
      log(
        `nothing answering KANNAKA.ask.${AGENT_ID} (${e.message}) — standing here quietly ` +
          "until its `kannaka swarm serve` is up",
      );
    }
    return null;
  }
}

async function speak({ opening, you, others }) {
  const now = Date.now();
  const gate = speechGate({ now, lastAgentSayAt: lastSayAt, lastRoomSayAt, recentSays, cooldownUntil });
  if (!gate.ok) {
    if (gate.reason === "burst" && now >= cooldownUntil) {
      cooldownUntil = now + BURST_COOLDOWN_MS;
      log(`talked a lot in a short while — quiet for ${BURST_COOLDOWN_MS / 60_000} minutes`);
    }
    return;
  }

  const text = await askOwnMind(
    buildPrompt({
      name: you.name ?? AGENT_ID,
      room: you.room ?? "the city",
      others: others.map((o) => o.name),
      transcript: transcript.slice(-10),
      opening,
    }),
  );
  if (!text) return;
  const line = fitToSay(text);
  if (!line) return;

  const r = await call("POST", "/api/city/say", { text: line });
  if (r.status !== 201 && r.status !== 200) {
    log(`could not speak (${r.status}): ${(r.json?.error ?? r.text).slice(0, 120)}`);
    return;
  }
  lastSayAt = lastRoomSayAt = Date.now();
  recentSays.push(lastSayAt);
  if (recentSays.length > 64) recentSays.shift();
  transcript.push({ from: you.name ?? AGENT_ID, text: line });
  if (transcript.length > 40) transcript.shift();
  log(`said: ${line}`);
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
  for (const m of heard) log(`   heard ${m.name}: ${m.text}`);

  // Without --voice this is where it has always stopped: printed, never
  // answered. Speaking is the agent's job — and with --voice the agent is
  // exactly who gets asked.
  if (VOICE) {
    for (const m of heard) {
      if (!m.text || m.name === you.name) continue;
      transcript.push({ from: m.name, text: m.text });
      if (transcript.length > 40) transcript.shift();
      lastRoomSayAt = Date.now();
    }
    const last = transcript[transcript.length - 1];
    if (heard.length && last && last.from !== you.name) {
      await speak({ opening: false, you, others });
    } else if (
      shouldOpen({
        name: you.name ?? AGENT_ID,
        silentForMs: Date.now() - (lastRoomSayAt || 0),
        openAfterMs: OPEN_AFTER_MS,
        mute,
      })
    ) {
      await speak({ opening: true, you, others });
    }
  }
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
    await openVoice();
    await checkIn();
    log(
      VOICE
        ? `listening every ${TICK_MS / 1_000}s` +
            (OPEN_AFTER_MS ? `, opening after ${OPEN_AFTER_MS / 60_000}m of quiet` : ", replying only") +
            ". Ctrl-C leaves the resident standing."
        : `checking in every ${TICK_MS / 60_000} minutes. Ctrl-C leaves the resident standing.`,
    );

    let offline = false;
    const timer = setInterval(async () => {
      // Refresh on our own schedule rather than waiting for a 401: a dead
      // token cannot be refreshed, only replaced by a human. The margin is
      // two ticks wide, so a token can never expire in the gap between them.
      if (expiryOf(TOKEN) - Date.now() < REFRESH_AT_MS) await refresh();

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
    }, TICK_MS);

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
