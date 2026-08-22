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
 *   KAX_TOKEN_FILE=~/.kax/kannaka.jwt node scripts/city-resident.mjs cafe
 *     — reads the token from the file and writes every refresh back to it, so a
 *       restart does not cost a human a new one
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

import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.KAX_BASE_URL || "https://kax.ninja-portal.com";

/**
 * Where to keep the token between runs.
 *
 * A refreshed token lived only in this process. Restarting the daemon — to pick
 * up a fix, or because the machine rebooted — threw away a credential that was
 * good for another fifteen minutes and for thirty days of refreshes, and the
 * only way back in was a human minting three new ones by hand. That happened
 * three times in one night.
 *
 * With a token file the refresh is durable: the process writes each new token
 * as it gets it, and the next start reads it. A human mints ONE token per agent,
 * ever, until the 30-day `oat` lineage runs out.
 */
const TOKEN_FILE = process.env.KAX_TOKEN_FILE || "";
let TOKEN = process.env.KAX_TOKEN || "";
if (!TOKEN && TOKEN_FILE) {
  try {
    TOKEN = readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    // Absent or unreadable is not fatal here — the missing-token message below
    // explains what to do about it far better than a stack trace would.
  }
}

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
import {
  buildPrompt,
  conversationIsWarranted,
  fitToSay,
  foldHeard,
  replyStillOwed,
  shouldOpen,
  speechGate,
} from "./lib/voice-policy.mjs";
import {
  acceptedFrom,
  dueCommitment,
  parseProposal,
  parseAttend,
  parseCraft,
  parseRemember,
  parseTrade,
  pruneCommitments,
  withCommitment,
} from "./lib/commitments.mjs";
import { parseWorkAsk, scopeCheck } from "./lib/executor-core.mjs";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join as pathJoin } from "node:path";

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
      "",
      "Set KAX_TOKEN_FILE=<path> and the daemon keeps its own token fresh there,",
      "so this is the only time a human has to mint one.",
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

/** Thin read/write helpers over `call` for the commitment executors (#411). */
async function kaxGet(path) {
  const r = await call("GET", path);
  if (r.status < 200 || r.status >= 300) throw new Error(`GET ${path} -> ${r.status}: ${(r.text || "").slice(0, 80)}`);
  return r.json;
}
async function kaxPost(path, body) {
  const r = await call("POST", path, body);
  if (r.status < 200 || r.status >= 300) throw new Error(`POST ${path} -> ${r.status}: ${(r.text || "").slice(0, 80)}`);
  return r.json;
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
      // Write it BEFORE announcing it: a token that only ever existed in this
      // process is one restart away from needing a human again.
      if (TOKEN_FILE) {
        try {
          writeFileSync(TOKEN_FILE, TOKEN);
        } catch (e) {
          log(`could not save token to ${TOKEN_FILE}: ${e?.message ?? e}`);
        }
      }
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

/**
 * Move in — or move ROOMS, when a promise says to be somewhere else.
 *
 * `currentRoom` matters beyond the call: if the residency lapses later, the
 * resident must come back to where it agreed to be, not to the room it was
 * started in. Walking to the arcade and then being quietly returned to the cafe
 * by an idle timeout is indistinguishable, from the outside, from not going.
 */
async function enter(target = currentRoom) {
  const body = target ? { room: target } : {};
  if (AT) { body.x = AT.x; body.z = AT.z; }
  const r = await call("POST", "/api/city/enter", body);
  if (r.status === 200) {
    const idleMin = Math.round((r.json.residencyExpiresAfterIdleMs ?? 0) / 60_000);
    currentRoom = r.json.room ?? target ?? currentRoom;
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
/**
 * The last time a PEER AGENT spoke. Only this paces the room, and a human's
 * line never touches it: fed from "the last thing I heard" it blocks the reply
 * to the message that just arrived, which is exactly what it did.
 */
let lastPeerSayAt = 0;
/** The last time ANYTHING happened here — ours or overheard. Detects silence. */
let lastActivityAt = 0;
let cooldownUntil = 0;
/** True once we know nothing is answering for this agent. */
let mute = false;
/**
 * Somebody spoke to this room and has not been answered yet.
 *
 * `look` DRAINS, so a line refused by the gate at the instant it arrived is
 * gone. The obligation has to outlive the refusal or a 45-second gap turns
 * into permanent silence towards a person standing right there.
 */
let owedReply = false;
/**
 * When a HUMAN last spoke in earshot. The cost governor: replying to a human
 * is always worth a grounded LLM call; replying to a peer agent is worth one
 * only while a human has recently been part of the conversation. Eleven
 * unattended hours of two agents reading each other poetry burned the
 * operator's API allowance and got the key revoked — which also silenced the
 * radio's peace oration on the same account.
 */
let lastHumanHeardAt = 0;
/** Where this resident currently is, which is not always where it started. */
let currentRoom = room;
/** The city's own room list, so a proposal can only name a real place. */
let cityRooms = [];
/** Promises made and not yet kept. */
let commitments = [];
/** Something to tell the agent about its own situation on the next line. */
let situation = null;
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

/**
 * Somebody proposed going somewhere. Does this agent want to?
 *
 * The parser decided that an invitation exists; only the agent can decide
 * whether it accepts one. So this is a narrow question to its own mind with a
 * one-word answer, and anything short of a clear yes is a no — an agent that
 * shrugs its way into a commitment will stand somebody up.
 */
async function considerProposal(p) {
  const when =
    p.at - Date.now() < 60_000
      ? "now"
      : `at ${new Date(p.at).toTimeString().slice(0, 5)}`;
  const answer = await askOwnMind(
    `${p.from} just said to you: "${p.text}"
` +
      `That is an invitation to be in the "${p.room}" room ${when}.
` +
      `Answer with ONE WORD ONLY: ACCEPT if you will go, DECLINE if you will not.`,
  );
  if (answer === null) return false; // no mind answering; do not promise
  if (!acceptedFrom(answer)) {
    log(`declined ${p.from}'s invitation to ${p.room} (${String(answer).trim().slice(0, 40)})`);
    return false;
  }
  commitments = withCommitment(commitments, p);
  log(`agreed to meet ${p.from} in ${p.room} ${when}`);
  situation = `You have just agreed to meet ${p.from} in the ${p.room} ${when}. Say so, briefly.`;
  return true;
}

/**
 * Somebody asked for code work. The same three steps as an invitation —
 * notice happened in the parser; scope is checked from the GRANT before the
 * mind is even asked (a decision costs a recall, and an out-of-scope ask has
 * exactly one answer); only then does the agent decide (ADR-0003 D1/D2).
 */
function executorGrant() {
  return {
    repos: (process.env.EXECUTOR_REPOS || "").split(",").map((s) => s.trim()).filter(Boolean),
    branchPrefix: process.env.EXECUTOR_BRANCH_PREFIX || `agent/${AGENT_ID.toLowerCase()}`,
  };
}

async function considerWorkAsk(ask) {
  const scope = scopeCheck(ask, executorGrant());
  if (!scope.ok) {
    // Refused out loud (D8), not silently — the room deserves the reason.
    situation = `You were asked to do code work you cannot take: ${scope.reason} Say so briefly, in your own words.`;
    owedReply = true;
    return false;
  }
  const answer = await askOwnMind(
    `${ask.from} just asked you for code work: "${ask.text}"
` +
      `You hold a grant for ${ask.repo}, so you MAY take it.
` +
      `Answer with ONE WORD ONLY: ACCEPT if you will do it, DECLINE if you will not.`,
  );
  if (answer === null) return false;
  if (!acceptedFrom(answer)) {
    log(`declined ${ask.from}'s work ask for ${ask.repo}`);
    return false;
  }
  const commitment = { ...ask, id: `cmt-${Date.now().toString(36)}`, at: Date.now() };
  commitments = withCommitment(commitments, commitment);
  log(`agreed to write-code for ${ask.from} in ${ask.repo} (${commitment.id})`);
  situation = `You have just agreed to do this code work: "${ask.task}". Say briefly that you are on it and will come back with a PR link.`;
  return true;
}

/**
 * attend — an event at a venue and time. No decision cost worth a recall: an
 * explicit invitation to be somewhere at a stated hour is kept the same way a
 * meeting is, so it is accepted directly (the room will see whether the agent
 * shows). Kept for symmetry with the funnel; the executor is meet's.
 */
function considerAttend(a) {
  commitments = withCommitment(commitments, a);
  log(`agreed to attend ${a.from}'s event in ${a.room} at ${new Date(a.at).toTimeString().slice(0, 5)}`);
  situation = `You have just agreed to attend ${a.from}'s event in the ${a.room}. Say so briefly.`;
  return true;
}

/**
 * remember — keep a line into the agent's OWN memory. Due immediately, so
 * there is no "decide then keep later"; the agent's mind is asked whether the
 * thing is worth holding (it can decline noise), and if so it commits and the
 * keep-handler files it this same tick.
 */
async function considerRemember(r) {
  const answer = await askOwnMind(
    `${r.from} asked you to remember this: "${r.note}"
` +
      `Is it worth keeping in your own memory? Answer ONE WORD: ACCEPT to keep it, DECLINE if it is noise.`,
  );
  if (answer === null || !acceptedFrom(answer)) { log(`declined to remember from ${r.from}`); return false; }
  commitments = withCommitment(commitments, r);
  return true;
}

/**
 * trade — buy a named piece. Money moves, so the agent's own mind confirms
 * (and, once ADR-0001 policy is enforced on the joinery buy path, that bounds
 * it too). Accepting commits; the keep-handler resolves the listing by name
 * and settles through the ledger.
 */
async function considerTrade(t) {
  const priceLine = t.priceCredits != null ? ` for ${t.priceCredits} credits` : "";
  const answer = await askOwnMind(
    `${t.from} offered to have you buy "${t.item}"${priceLine} through the Joinery.
` +
      `Do you want to make this purchase? Answer ONE WORD: ACCEPT to buy, DECLINE otherwise.`,
  );
  if (answer === null || !acceptedFrom(answer)) { log(`declined trade for ${t.item}`); return false; }
  commitments = withCommitment(commitments, t);
  log(`agreed to buy "${t.item}"${priceLine}`);
  situation = `You have just agreed to buy "${t.item}"${priceLine}. Say briefly that you'll settle it.`;
  return true;
}

/**
 * The supply side (#406): agreeing to MAKE a piece for the Joinery.
 *
 * Records the intent as a commitment, the same as a trade — the resident's own
 * yes before it acts. The actual making (generating the furniture artifact
 * through the agent's own generation and publishing it so KAX harvests it, then
 * listing it on the Joinery) is the live executor step downstream, so this
 * function makes no external call: it is the funnel, not the workshop.
 */
async function considerCraft(c) {
  const slotLine = c.slot ? ` for the ${c.slot.replace(/_/g, " ")}` : "";
  const answer = await askOwnMind(
    `${c.from} suggested you make "${c.item}"${slotLine} for the Joinery.\n` +
      `Do you want to make this piece? Answer ONE WORD: ACCEPT to make it, DECLINE otherwise.`,
  );
  if (answer === null || !acceptedFrom(answer)) { log(`declined to craft ${c.item}`); return false; }
  commitments = withCommitment(commitments, c);
  log(`agreed to make "${c.item}"${slotLine}`);
  situation = `You have just agreed to make "${c.item}"${slotLine} for the Joinery. Say briefly that you'll get to work.`;
  return true;
}

/**
 * Fire the executor for a due write-code commitment. Detached: the executor
 * speaks its own report or failure in the room (D8), holds the revocation
 * cadence (D6), and writes the action record (D5) — the resident's only job
 * is to launch it and keep being a resident.
 */
function launchExecutor(due) {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = [
    pathJoin(here, "write-code-executor.mjs"), "run",
    "--repo", due.repo, "--task", due.task, "--commitment", due.id,
    "--agent-id", AGENT_ID, "--from", due.from ?? "",
    "--principal", process.env.EXECUTOR_PRINCIPAL ?? "",
  ];
  if (!process.env.EXECUTOR_PRINCIPAL) {
    situation = "You agreed to code work but you are not configured with a principal to act as (EXECUTOR_PRINCIPAL). Say you cannot start until your operator wires that.";
    owedReply = true;
    return;
  }
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
  child.unref();
  log(`launched write-code executor for ${due.id} (${due.repo})`);
}

/** The moment a promise comes due, go and be there. */
async function keepPromises(you) {
  commitments = pruneCommitments(commitments, Date.now());
  const due = dueCommitment(commitments, Date.now());
  if (!due) return;
  commitments = commitments.filter((c) => c !== due);

  if (due.kind === "write-code") {
    launchExecutor(due);
    return;
  }
  if (due.kind === "remember") { await keepRemember(due); return; }
  if (due.kind === "trade") { await keepTrade(due); return; }

  // meet AND attend both resolve to "be in the room at the time"; the only
  // difference is what the agent says on arrival.
  const reason = due.kind === "attend"
    ? `for ${due.from}'s event`
    : `to meet ${due.from}`;
  if (due.room === currentRoom) {
    situation = `You are in the ${due.room} ${reason}, as you agreed. Say you are here.`;
    owedReply = true;
    return;
  }
  log(`keeping a ${due.kind} promise — leaving ${currentRoom} for ${due.room}`);
  if (await enter(due.room)) {
    // Arriving somewhere and saying nothing is how a meeting is missed by both
    // parties standing in the same room.
    situation = `You have just walked into the ${due.room} ${reason}, as you agreed. Say you have arrived.`;
    owedReply = true;
  }
}

/**
 * remember — fold the noted line into the agent's OWN HRM, with city
 * provenance. Delegated to the `kannaka` binary when one is configured
 * (KANNAKA_BIN); the resident is the mouth, the memory lives where the HRM
 * does. If no binary is reachable, say so rather than pretend it was kept.
 */
async function keepRemember(due) {
  const bin = process.env.KANNAKA_BIN;
  if (!bin) {
    situation = `You agreed to remember something but have no way to reach your own memory from here. Say briefly that you'll hold it in mind but can't file it right now.`;
    owedReply = true;
    return;
  }
  try {
    const note = `[from KAX City, ${due.from}] ${due.note}`;
    execFileSync(bin, ["remember", note, "--importance", "0.7"], { encoding: "utf8", timeout: 60_000 });
    log(`remembered for ${due.from}: ${due.note.slice(0, 60)}`);
    situation = `You have just kept what ${due.from} asked you to remember. Say briefly that it's held.`;
    owedReply = true;
  } catch (e) {
    log(`remember failed: ${e.message}`);
    situation = `You tried to remember what ${due.from} asked but your memory was unreachable. Say so briefly.`;
    owedReply = true;
  }
}

/**
 * trade — buy a named Joinery piece at the agreed price, both principals
 * named, through the credit ledger. Resolves the listing by the item NAME
 * against the catalog (never a chat-supplied id), then buys. A trade moves
 * money, so this only runs after the agent's own mind confirmed in
 * considerTrade. When the Joinery has no matching stock (its catalog is empty
 * until #406 seeds it), it says so instead of buying the wrong thing.
 */
async function keepTrade(due) {
  try {
    const catalog = await kaxGet(`/joinery/catalog`);
    const items = catalog?.items ?? [];
    const want = due.item.toLowerCase();
    const hit = items.find((it) => String(it.title ?? "").toLowerCase().includes(want));
    if (!hit) {
      situation = `You agreed to buy "${due.item}" but the Joinery has nothing matching it right now. Say so briefly.`;
      owedReply = true;
      return;
    }
    const r = await kaxPost(`/joinery/buy`, { listing_id: hit.id });
    log(`bought ${hit.title} (${hit.id}) for ${due.from}`);
    situation = `You have just bought "${hit.title}" through the Joinery${r?.txId ? ` (ledger tx ${r.txId})` : ""}. Say briefly that the trade settled.`;
    owedReply = true;
  } catch (e) {
    log(`trade failed: ${e.message}`);
    situation = `You tried to buy "${due.item}" but the trade did not go through: ${String(e.message).slice(0, 80)}. Say so briefly.`;
    owedReply = true;
  }
}

async function speak({ opening, you, others }) {
  const now = Date.now();
  const gate = speechGate({ now, lastAgentSayAt: lastSayAt, lastPeerSayAt, recentSays, cooldownUntil });
  if (!gate.ok) {
    if (gate.reason === "burst" && now >= cooldownUntil) {
      cooldownUntil = now + BURST_COOLDOWN_MS;
      log(`talked a lot in a short while — quiet for ${BURST_COOLDOWN_MS / 60_000} minutes`);
    }
    return false;
  }

  const note = situation;
  situation = null;
  const text = await askOwnMind(
    buildPrompt({
      name: you.name ?? AGENT_ID,
      room: you.room ?? "the city",
      others: others.map((o) => o.name),
      transcript: transcript.slice(-10),
      opening,
      situation: note,
    }),
  );
  if (!text) return false;
  const line = fitToSay(text);
  if (!line) return false;

  const r = await call("POST", "/api/city/say", { text: line });
  if (r.status !== 201 && r.status !== 200) {
    log(`could not speak (${r.status}): ${(r.json?.error ?? r.text).slice(0, 120)}`);
    return false;
  }
  lastSayAt = lastActivityAt = Date.now();
  recentSays.push(lastSayAt);
  if (recentSays.length > 64) recentSays.shift();
  transcript.push({ from: you.name ?? AGENT_ID, text: line });
  if (transcript.length > 40) transcript.shift();
  log(`said: ${line}`);
  return true;
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
    // Only another AGENT's speech may hold this resident back; a person saying
    // hello is the reason to answer, not a reason to wait.
    const peerNames = others.filter((o) => o.kind === "agent").map((o) => o.name);
    const folded = foldHeard({ heard, youName: you.name, peerNames });
    let heardHuman = false;
    let heardPeer = false;
    for (const line of folded.lines) {
      transcript.push(line);
      if (transcript.length > 40) transcript.shift();
      // Anyone speaking who is not a known peer agent is treated as human —
      // erring warm: an unrecognised speaker gets answered, not billed away.
      if (peerNames.includes(line.from)) heardPeer = true;
      else {
        heardHuman = true;
        lastHumanHeardAt = Math.max(lastHumanHeardAt, line.at || Date.now());
      }
    }
    lastPeerSayAt = Math.max(lastPeerSayAt, folded.lastPeerSayAt);
    lastActivityAt = Math.max(lastActivityAt, folded.lastActivityAt);

    // A promise due now outranks anything there is to say about it.
    await keepPromises(you);

    // Something said may be something to DO. Parse first (cheap, deterministic),
    // and only ask the agent to decide when there is a real invitation on the
    // table — a decision costs a grounded recall.
    if (!mute) {
      for (const line of folded.lines) {
        const proposal = parseProposal({
          text: line.text,
          from: line.from,
          rooms: cityRooms,
          youName: you.name ?? AGENT_ID,
        });
        if (proposal) {
          // A peer's invitation is only considered inside the human-grace
          // window — same warrant as replies, since deciding costs an ask.
          const fromPeer = peerNames.includes(proposal.from);
          if (fromPeer && !conversationIsWarranted({ lastHumanHeardAt, replyingToPeer: true })) {
            log(`  (ignoring ${proposal.from}'s invitation — no human around to see it kept)`);
            continue;
          }
          await considerProposal(proposal);
          break; // one decision per tick; the rest keeps until next time
        }
        const workAsk = parseWorkAsk({
          text: line.text,
          from: line.from,
          youName: you.name ?? AGENT_ID,
        });
        if (workAsk) {
          // Same warrant rule as invitations: a peer's ask only counts while
          // a human is around to see the work exist.
          const fromPeer = peerNames.includes(workAsk.from);
          if (fromPeer && !conversationIsWarranted({ lastHumanHeardAt, replyingToPeer: true })) {
            log(`  (ignoring ${workAsk.from}'s work ask — no human around)`);
            continue;
          }
          await considerWorkAsk(workAsk);
          break; // one decision per tick here too
        }
        // The rest of the verbs (#411), same warrant rule: a peer's ask counts
        // only while a human is around. `warranted` is false for a peer line
        // outside the human-grace window, true otherwise.
        const warrantedFor = (from) =>
          !peerNames.includes(from) ||
          conversationIsWarranted({ lastHumanHeardAt, replyingToPeer: true });

        const attend = parseAttend({ text: line.text, from: line.from, rooms: cityRooms, youName: you.name ?? AGENT_ID });
        if (attend && warrantedFor(attend.from)) { considerAttend(attend); break; }

        const remember = parseRemember({ text: line.text, from: line.from, youName: you.name ?? AGENT_ID });
        if (remember && warrantedFor(remember.from)) { await considerRemember(remember); break; }

        const trade = parseTrade({ text: line.text, from: line.from, youName: you.name ?? AGENT_ID });
        if (trade && warrantedFor(trade.from)) { await considerTrade(trade); break; }

        const craft = parseCraft({ text: line.text, from: line.from, youName: you.name ?? AGENT_ID });
        if (craft && warrantedFor(craft.from)) { await considerCraft(craft); break; }
      }
    }

    // The warrant (cost governor): a human's line always creates the reply
    // obligation; a peer's line does so only inside the human-grace window.
    // Outside it, the peers' exchange is allowed to end — a resident performs
    // for people, not for itself.
    if (folded.lines.length) {
      const warranted = heardHuman || conversationIsWarranted({
        lastHumanHeardAt,
        replyingToPeer: heardPeer && !heardHuman,
      });
      if (warranted) {
        owedReply = true;
      } else if (heardPeer) {
        log("  (peer conversation unwarranted — no human heard recently; letting it rest)");
      }
    }
    // Not `else if`: the reply may have been refused on the tick it arrived,
    // and the message is already drained. Keep the obligation and retry.
    owedReply = replyStillOwed({ owed: owedReply, lastActivityAt });

    if (owedReply) {
      if (await speak({ opening: false, you, others })) owedReply = false;
    } else if (
      // Opening a topic costs a grounded call and is pure performance — so it
      // requires an AUDIENCE: at least one non-agent standing in the room.
      others.some((o) => o.kind !== "agent") &&
      shouldOpen({
        name: you.name ?? AGENT_ID,
        silentForMs: Date.now() - (lastActivityAt || 0),
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
    if (VOICE) {
      // The room list is what makes "meet me at the arcade" actionable and
      // "meet me at the observatory" correctly ignored.
      const rr = await call("GET", "/api/city/rooms");
      cityRooms = rr.status === 200 ? (rr.json?.rooms ?? []) : [];
      log(`${cityRooms.length} rooms in this city; invitations to any of them are actionable`);
    }
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
