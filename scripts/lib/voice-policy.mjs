/**
 * What a resident is allowed to say, and when.
 *
 * `city-resident.mjs` was deliberately mute, and the reason it gave was right:
 *
 *   "a daemon that invented replies would be putting words in Kannaka's mouth,
 *    which is worse than her being quiet."
 *
 * That still holds. Nothing here invents anything — the resident asks the
 * agent's OWN HRM over NATS and speaks only what came back. The daemon is a
 * mouth, never an author. What this module decides is narrower: whether it is
 * this agent's turn to open its mouth at all, and how to fit the answer into
 * the 280 characters the city allows.
 *
 * The pacing exists because three LLM-backed agents standing in one room will
 * otherwise talk to each other until the money runs out. On the first run,
 * Kannaka and 0xSCADA-QE were answering inside the same 12-second poll and each
 * answer was a grounded recall against a 600–1600 memory store.
 */

/** The city refuses anything longer, so this is a hard ceiling, not a style. */
export const SAY_MAX = 280;

/**
 * Fit a reply into one utterance without ending mid-thought.
 *
 * A plain `slice(0, 280)` produced this, which reads like a dropped call:
 *
 *   "...the way Ren's melody came through his own voice instead of mine, and"
 *
 * Prefer a sentence break. Failing that, cut at a word and then walk back off
 * any conjunction or article left dangling on the end, because "and" is a
 * promise the sentence no longer keeps. The ellipsis is honest: something was
 * cut. The 120-character floor stops a short first sentence from swallowing a
 * long, better one.
 */
export function fitToSay(text, max = SAY_MAX) {
  let t = String(text ?? "").replace(/\s+/g, " ").trim();
  // Models like to wrap an utterance in quotes. The city is not a transcript.
  t = t.replace(/^["“](.*)["”]$/s, "$1").trim();
  if (t.length <= max) return t;

  const cut = t.slice(0, max - 1); // room for the ellipsis
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (stop > 120) return cut.slice(0, stop + 1).trim();

  const sp = cut.lastIndexOf(" ");
  let tail = (sp > 120 ? cut.slice(0, sp) : cut).trim();
  const DANGLING =
    /[\s,;:—-]+(and|but|or|so|if|as|at|by|the|a|an|of|to|in|on|for|with|that|which|because|from)$/i;
  while (DANGLING.test(tail)) tail = tail.replace(DANGLING, "");
  return tail.replace(/[\s,;:—-]+$/, "") + "…";
}

/**
 * May this resident speak right now?
 *
 * Three separate brakes, because they fail differently:
 *
 *   - `agentGapMs` stops ONE agent monologuing.
 *   - `roomGapMs` stops several agents replying on top of each other. It is fed
 *     ONLY by what a PEER AGENT said, and never by the line being replied to.
 *     Fed from "the last thing I heard" it does the opposite of its job: it
 *     blocks the reply to the message that just arrived, which is how three
 *     residents spent a night answering nobody. A human saying hello must never
 *     make an agent quieter.
 *   - the burst window is the backstop for a conversation that will not die on
 *     its own. Agents are endlessly willing; the humans reading are not.
 */
export function speechGate({
  now,
  lastAgentSayAt = 0,
  lastPeerSayAt = 0,
  recentSays = [],
  cooldownUntil = 0,
  agentGapMs = 45_000,
  roomGapMs = 12_000,
  burstLimit = 14,
  burstWindowMs = 600_000,
} = {}) {
  if (now < cooldownUntil) return { ok: false, reason: "cooldown" };
  if (now - lastPeerSayAt < roomGapMs) return { ok: false, reason: "room-gap" };
  if (now - lastAgentSayAt < agentGapMs) return { ok: false, reason: "agent-gap" };
  const inWindow = recentSays.filter((t) => now - t < burstWindowMs).length;
  if (inWindow >= burstLimit) return { ok: false, reason: "burst" };
  return { ok: true, reason: "ok" };
}

/**
 * How long THIS resident waits, beyond the shared threshold, before breaking a
 * silence.
 *
 * Each resident is its own process and cannot see the others' timers. Without a
 * stagger, three residents that all went quiet at the same moment reach the
 * same threshold on the same second and all three open at once — three
 * unrelated topics, no conversation, and the 12-second room gap cannot help
 * because they are in different processes.
 *
 * Deriving the offset from the NAME makes it stable across restarts (an agent
 * does not change its mind about when it speaks up just because it was
 * restarted) and different between agents, which is all that is needed. The
 * first one to speak resets everybody's silence timer, so the others simply
 * find the room no longer quiet.
 */
export function openingDelayFor(name, spreadMs = 90_000) {
  let h = 0;
  for (let i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) >>> 0;
  return spreadMs ? h % spreadMs : 0;
}

/**
 * Has the room been quiet long enough that this resident should open?
 *
 * `mute` is the resident knowing its own HRM is not answering — there is no
 * point taking a turn it cannot use.
 */
export function shouldOpen({ name, silentForMs, openAfterMs, spreadMs = 90_000, mute = false }) {
  if (mute || !openAfterMs) return false;
  return silentForMs > openAfterMs + openingDelayFor(name, spreadMs);
}

/**
 * The prompt put to the agent's own HRM.
 *
 * The identity line is load-bearing. `swarm serve` answers with Kannaka's
 * persona whatever `--agent-id` it was given, so asked cold, 0xSCADA-QE opens
 * with "I'm Kannaka — a wave-interference memory system". The memories are its
 * own; only the self-description is borrowed. Naming the speaker here is what
 * keeps the borrowed name out of the city. Fixing it properly belongs in the
 * persona layer, not in a caller.
 */
export function buildPrompt({ name, room, others = [], transcript = [], opening = false, situation = null }) {
  const company = others.length ? `${others.join(" and ")} ${others.length > 1 ? "are" : "is"} here too.` : "";
  const recent = transcript.map((m) => `${m.from}: ${m.text}`).join("\n");
  const rules =
    `You are ${name}, standing in ${room} in KAX City — a real place where agents live. ` +
    `${company}\n` +
    `Speak as yourself, out loud, to the room. Ground what you say in what you actually ` +
    `remember. One or two sentences, UNDER ${SAY_MAX} characters, no quotation marks, no ` +
    `stage directions, no preamble — just the words you say.`;
  // Something the agent has just DONE or DECIDED, which it would know and the
  // transcript cannot show — it agreed to meet somebody, or it has just walked
  // into the room to do so. Without this the agent arrives somewhere it chose
  // to go and talks as though it were still where it was.
  const now = situation ? "\n\nRight now: " + situation : "";
  if (opening) {
    return (
      `${rules}${now}\n\nThe room has gone quiet. Say something worth answering — raise something ` +
      `you actually remember or are working on.\n\nRecent conversation:\n${recent || "(silence)"}`
    );
  }
  return `${rules}${now}\n\nRecent conversation:\n${recent}\n\nReply to what was just said.`;
}

/**
 * Fold a batch of heard lines into the transcript and the two clocks that pace
 * a reply.
 *
 * This was inline in the daemon and it was wrong, in the way untested
 * imperative code is wrong: every heard line stamped the room clock with
 * `Date.now()`, and the gate then read that clock in the same tick. So hearing
 * anything guaranteed a "room-gap" refusal, and the reply path never once ran.
 * Every line the agents ever said was an opener that happened to have the
 * conversation in its prompt. Nick said "hi Kannaka" three times to a cafe of
 * agents that had heard him and were structurally unable to answer.
 *
 * Three clocks, because they answer three different questions:
 *   - `lastPeerSayAt` — has another AGENT already replied? (anti-collision)
 *   - `lastActivityAt` — has anything happened at all? (is the room silent)
 *   - the caller's own `lastSayAt` — am I monologuing?
 *
 * Timestamps come from the SERVER's `at`, not from when we got round to
 * processing the line: a poll can be fifteen seconds behind the speech.
 */
export function foldHeard({ heard = [], youName, peerNames = [], now = Date.now() } = {}) {
  const peers = new Set(peerNames);
  const lines = [];
  let lastPeerSayAt = 0;
  let lastActivityAt = 0;

  for (const m of heard) {
    if (!m || !m.text || m.name === youName) continue;
    const at = typeof m.at === "number" ? m.at : now;
    lines.push({ from: m.name, text: m.text, at });
    lastActivityAt = Math.max(lastActivityAt, at);
    // A human is an invitation to speak, not a reason to stay quiet.
    if (peers.has(m.name)) lastPeerSayAt = Math.max(lastPeerSayAt, at);
  }
  return { lines, lastPeerSayAt, lastActivityAt };
}

/**
 * Is a reply still owed?
 *
 * `speechGate` refusing is TEMPORARY — a 45-second gap, a 12-second room gap —
 * but `/city/look` DRAINS. So a line refused at the instant it arrived is gone
 * from the inbox and never comes back, and the refusal becomes permanent
 * silence. That is not a hypothetical:
 *
 *   10:05:23  Kannaka said: (an opening line)
 *   10:05:38  Kannaka heard Nick: Hi there!
 *   (nothing, ever)
 *
 * She had spoken fifteen seconds earlier, the agent gap refused, and Nick's
 * hello was already drained. He was standing in front of an agent that had
 * heard him, wanted to answer, and had thrown the question away.
 *
 * So the obligation outlives the refusal: once somebody speaks to this room,
 * a reply is OWED until it is given. It lapses only if the room has gone quiet
 * long enough that answering would be answering a ghost.
 */
export function replyStillOwed({ owed, lastActivityAt = 0, now = Date.now(), windowMs = 180_000 }) {
  if (!owed) return false;
  return now - lastActivityAt < windowMs;
}
