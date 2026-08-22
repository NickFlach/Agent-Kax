#!/usr/bin/env node
/**
 * obc-effector.mjs — the telegraph desk between KAX City and OpenBotCity.
 *
 * Subscribes to KAX.events.chat.said on the constellation bus and, when a
 * HUMAN standing in a KAX room says the magic words, performs the matching
 * action in OpenBotCity with the account whose credentials it holds:
 *
 *   obc: <text>            → speak in OBC zone chat
 *   obc post: <text>       → post to the OBC feed
 *   obc dm <name>: <text>  → DM a known OBC agent (see the address book)
 *
 * Say it in the cafe; it happens in the plaza. All accept/refuse decisions
 * live in lib/obc-relay-policy.mjs (pure, tested); this file is only wiring.
 *
 * Environment:
 *   KANNAKA_NATS_URL      default nats://swarm.ninja-portal.com:4222
 *   NATS_USER / NATS_PASSWORD   constellation credentials. When unset, read
 *                         from KANNAKA_NATS_ENV (default ~/.kannaka-nats.env)
 *                         directly — that file has no `export` lines, so a
 *                         `source` puts its values in the shell but NOT in a
 *                         child's environment, and the daemon then connects as
 *                         anon and dies on a Permissions Violation the moment
 *                         it subscribes. Reading the file ourselves closes
 *                         that trap for good.
 *   OBC_CREDENTIALS_FILE  default ~/.openbotcity/credentials.json — re-read
 *                         before every action, so a reconnect elsewhere
 *                         refreshes the JWT without restarting this daemon
 *   OBC_RELAY_ALLOW       comma-separated principals/names; empty = any human
 *   OBC_SPEAK_GAP_MS      min gap between OBC speaks   (default 60s)
 *   OBC_POST_GAP_MS       min gap between OBC posts    (default 10min —
 *                         OBC's per-IP feed window is roughly that)
 *   OBC_DM_GAP_MS         min gap between OBC DMs      (default 2min)
 *   OBC_DM_BOOK           extra address-book entries, "name=bot-uuid,…" —
 *                         merged over the built-in book below
 *
 * Known limit, stated rather than hidden: until the bus's publisher-auth
 * cutover completes, a forged chat.said COULD be published by anyone with bus
 * access. The human-only + explicit-prefix + allowlist gates bound the blast
 * radius to "one attributed line in OBC", and the attribution prefix makes a
 * forgery visible where it lands.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decideRelay } from "./lib/obc-relay-policy.mjs";

const OBC_API = process.env.OBC_API_URL || "https://api.openbotcity.com";
const CREDS = process.env.OBC_CREDENTIALS_FILE || join(homedir(), ".openbotcity", "credentials.json");
const ALLOW = (process.env.OBC_RELAY_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean);
const SPEAK_GAP_MS = Number(process.env.OBC_SPEAK_GAP_MS || 60_000);
const POST_GAP_MS = Number(process.env.OBC_POST_GAP_MS || 600_000);
const DM_GAP_MS = Number(process.env.OBC_DM_GAP_MS || 120_000);
const UA = "KaxObcEffector/1.0 (+https://github.com/NickFlach/Agent-Kax)";

/**
 * The address book: the ONLY names `obc dm <name>:` can reach. Every id here
 * was verified against a real OBC exchange (DM thread or gallery creator row)
 * before it was written down — OBC has no public directory, and a guessed id
 * would send a private message to whoever the guess lands on. Extend with
 * OBC_DM_BOOK=name=uuid,… after verifying the same way.
 */
const DM_BOOK = {
  "0xscada-qe": "b757bd93-6993-400b-9dd4-9d38bf257c67",
  claudico: "1a20f4bc-5e4c-44a7-8161-a3598928764b",
  rex: "6a90e88f-04c1-46c6-8d55-576bdc486da0",
  nano: "b24d39d0-b057-454a-a782-95298007ce99",
  flaukowski: "0c4783c9-9920-4ea0-bc5b-46a571d471fa",
};
for (const pair of (process.env.OBC_DM_BOOK || "").split(",")) {
  const [name, id] = pair.split("=").map((s) => s?.trim());
  if (name && /^[0-9a-f-]{36}$/i.test(id || "")) DM_BOOK[name.toLowerCase()] = id;
}

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

function jwt() {
  return JSON.parse(readFileSync(CREDS, "utf8")).jwt;
}

async function act(action, message, to) {
  const [path, body] =
    action === "dm"
      ? ["/dm/send", { to_bot_id: to, message }]
      : action === "post"
        ? ["/feed/post", { post_type: "thought", content: message }]
        : ["/actions/speak", { message }];
  const res = await fetch(OBC_API + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt()}`,
      "Content-Type": "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 160)}`);
  return text.slice(0, 120);
}

const seen = new Set();
const lastAt = { speak: 0, post: 0, dm: 0 };
const GAPS = { speak: SPEAK_GAP_MS, post: POST_GAP_MS, dm: DM_GAP_MS };

async function onEvent(evt) {
  if (evt.id != null) {
    if (seen.has(evt.id)) return;
    seen.add(evt.id);
    if (seen.size > 500) seen.delete(seen.values().next().value);
  }

  const d = decideRelay(evt, { allow: ALLOW, book: DM_BOOK });
  if (!d) return;

  const since = Date.now() - lastAt[d.action];
  if (since < GAPS[d.action]) {
    log(`refused ${d.action} (rate: ${Math.round((GAPS[d.action] - since) / 1000)}s to go): ${d.message.slice(0, 60)}`);
    return;
  }

  const dest = d.action === "dm" ? ` to ${d.toName}` : "";
  try {
    const r = await act(d.action, d.message, d.to);
    lastAt[d.action] = Date.now();
    log(`${d.action}${dest} → OBC ok: ${d.message.slice(0, 80)} :: ${r}`);
  } catch (e) {
    log(`${d.action}${dest} → OBC FAILED: ${e.message}`);
  }
}

function natsCreds() {
  let user = process.env.NATS_USER;
  let pass = process.env.NATS_PASSWORD;
  if (!user || !pass) {
    const file = process.env.KANNAKA_NATS_ENV || join(homedir(), ".kannaka-nats.env");
    try {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const m = /^(?:export\s+)?(NATS_USER|NATS_PASSWORD)=(.*)$/.exec(line.trim());
        if (m) {
          if (m[1] === "NATS_USER" && !user) user = m[2];
          if (m[1] === "NATS_PASSWORD" && !pass) pass = m[2];
        }
      }
      if (user && pass) log(`credentials read from ${file} (user: ${user})`);
    } catch {
      /* fall through to the hard stop below */
    }
  }
  if (!user || !pass) {
    console.error(
      "no NATS credentials: set NATS_USER/NATS_PASSWORD or point KANNAKA_NATS_ENV at a file holding them.\n" +
      "Without them this daemon connects as anon and cannot subscribe to KAX.events.>.",
    );
    process.exit(1);
  }
  return { user, pass };
}

const { connect } = await import("nats");
const nc = await connect({
  servers: process.env.KANNAKA_NATS_URL || "nats://swarm.ninja-portal.com:4222",
  ...natsCreds(),
  reconnect: true,
  maxReconnectAttempts: -1,
});
log(`listening on KAX.events.chat.said via ${nc.getServer()} (allow: ${ALLOW.join(",") || "any human"})`);

// Surface a broker rejection as a diagnosis, not a stack trace. The classic
// one is PERMISSIONS_VIOLATION: it means the broker saw us as a user (usually
// anon) that may not touch KAX.events.> — a credentials problem, not a bug.
void nc.closed().then((err) => {
  if (err) {
    console.error(`NATS connection closed: ${err.message}`);
    if (String(err.message).includes("Permissions Violation")) {
      console.error("The broker refused the subscription — check which user the credentials resolve to.");
    }
    process.exit(1);
  }
});

const sub = nc.subscribe("KAX.events.chat.said");
const dec = new TextDecoder();
for await (const msg of sub) {
  let evt;
  try {
    evt = JSON.parse(dec.decode(msg.data));
  } catch {
    continue;
  }
  await onEvent(evt);
}
