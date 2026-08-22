/**
 * Turning something said into something done.
 *
 * A resident could talk and could not act. "Let's meet at the arcade in five
 * minutes" was, to it, just another line to answer — it would say something
 * agreeable and then stand exactly where it was, forever. Agreement without
 * follow-through is worse than refusing, because it reads as a promise.
 *
 * Three separable problems, and they want different tools:
 *
 *   NOTICE   Did somebody propose something? Deterministic, here. NOT the LLM:
 *            a model that hallucinates a meeting sends an agent across the city
 *            for a conversation nobody had, and the failure is invisible
 *            because the agent behaves with total confidence. A parser that
 *            misses an oddly-worded invitation is a much cheaper mistake, and
 *            the agent can still answer in words while missing the action.
 *
 *   DECIDE   Does this agent want to? That IS the model's job — it is a
 *            question about the agent, and its own mind should answer it. The
 *            caller asks a narrow question and reads a one-word answer.
 *
 *   KEEP     Hold the promise until its time comes, then act. A commitment is
 *            state that outlives the exchange that created it, which is the
 *            whole difference between chatting and doing.
 *
 * `meet` is the first kind because it is the one that can be checked by eye:
 * you say a place, and either the agent is standing there or it is not. The
 * shape generalises — a commitment is a kind, a due time, and enough context to
 * carry it out — which is the road to the ones that write code.
 */

/** A promise nobody keeps within this long was not a promise. */
export const COMMITMENT_LAPSE_MS = 15 * 60_000;
/** "Let's meet at the arcade" with no time said means about now, not instantly. */
export const SOON_MS = 45_000;

const MEET_INTENT =
  /\b(meet|meet up|see you|come (?:to|over|down|up)|head (?:to|over|down|up)|join me|let'?s go|shall we go|i'?ll be (?:at|in)|be (?:at|in) the|over (?:at|in) the|find me)\b/i;

/**
 * Build room aliases from what the city says it has, rather than a hardcoded
 * list that can drift out of date the moment a room is added.
 */
export function roomAliases(rooms = []) {
  const map = new Map();
  for (const r of rooms) {
    if (!r?.id) continue;
    map.set(r.id.toLowerCase(), r.id);
    const label = String(r.label ?? "").toLowerCase();
    if (label) {
      map.set(label, r.id);
      // "The Arcade" should also match "arcade"; "Flaukowski's Cafe" -> "cafe".
      const bare = label.replace(/^the\s+/, "").replace(/^\w+'s\s+/, "");
      if (bare) map.set(bare, r.id);
    }
  }
  // The street answers to what people actually call it.
  if (map.has("city")) {
    map.set("street", "city");
    map.set("the street", "city");
  }
  return map;
}

/**
 * When does "in five minutes" mean?
 *
 * Returns a timestamp, or null if no time was named — the caller decides what
 * an unstated time means, because "meet me at the bank" and "meet me at the
 * bank at nine" deserve different answers.
 */
export function parseWhen(text, now = Date.now()) {
  const t = String(text ?? "").toLowerCase();

  if (/\b(right now|now|immediately|straight away)\b/.test(t)) return now;

  const rel = /\bin\s+(a|an|one|two|three|four|five|ten|fifteen|thirty|\d{1,3})\s*(second|sec|minute|min|hour|hr)s?\b/.exec(t);
  if (rel) {
    const words = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, thirty: 30 };
    const n = words[rel[1]] ?? Number(rel[1]);
    const unit = rel[2];
    const ms = unit.startsWith("s") ? 1_000 : unit.startsWith("m") ? 60_000 : 3_600_000;
    if (Number.isFinite(n)) return now + n * ms;
  }

  const abs = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(t);
  if (abs) {
    let hour = Number(abs[1]);
    const min = Number(abs[2] ?? 0);
    const mer = abs[3];
    if (mer === "pm" && hour < 12) hour += 12;
    if (mer === "am" && hour === 12) hour = 0;
    const d = new Date(now);
    d.setHours(hour, min, 0, 0);
    // A time already gone today means tomorrow, not an hour ago.
    if (d.getTime() < now - 60_000) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  return null;
}

/**
 * Did this line propose going somewhere?
 *
 * Requires BOTH an intent phrase and a room the city actually has. Either alone
 * is ordinary conversation: "the arcade is loud" names a room and proposes
 * nothing, and "let's meet" proposes something with nowhere to be.
 */
export function parseProposal({ text, from, rooms = [], now = Date.now(), youName } = {}) {
  const line = String(text ?? "");
  if (!line || !from || from === youName) return null;
  if (!MEET_INTENT.test(line)) return null;

  const aliases = roomAliases(rooms);
  const lower = line.toLowerCase();
  // Longest alias first, so "ghost signals trading floor" wins over "floor".
  const names = [...aliases.keys()].sort((a, b) => b.length - a.length);
  const hit = names.find((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower));
  if (!hit) return null;

  const when = parseWhen(line, now);
  return {
    kind: "meet",
    room: aliases.get(hit),
    at: when ?? now + SOON_MS,
    timeWasStated: when !== null,
    from,
    text: line,
  };
}

/**
 * Did the agent agree?
 *
 * Deliberately strict about YES and forgiving about no: an ambiguous answer
 * must not become a promise. Anything that is not clearly an acceptance is
 * treated as a decline, because standing somebody up is worse than never
 * having agreed.
 */
export function acceptedFrom(answer) {
  const a = String(answer ?? "").trim().toLowerCase();
  if (!a) return false;
  if (/\bdecline|\bno\b|can'?t|cannot|won'?t|rather not|busy\b/.test(a)) return false;
  return /\baccept\b|\byes\b|\bagreed?\b|\bsure\b|of course|i'?ll be there|see you there|on my way\b/.test(a);
}

/** The commitment that is due now, if any. Earliest first, lapsed ones dropped. */
export function dueCommitment(commitments = [], now = Date.now()) {
  return (
    pruneCommitments(commitments, now)
      .filter((c) => c.at <= now)
      .sort((a, b) => a.at - b.at)[0] ?? null
  );
}

/** Forget promises whose moment has been and gone. */
export function pruneCommitments(commitments = [], now = Date.now()) {
  return commitments.filter((c) => now - c.at < COMMITMENT_LAPSE_MS);
}

/**
 * Replace rather than accumulate.
 *
 * An agent that agreed to three places at once will disappoint at least two,
 * and the most recently agreed plan is the one the room is expecting. Keyed on
 * kind, so a future `write-code` commitment does not evict a lunch.
 */
export function withCommitment(commitments = [], next) {
  return [...commitments.filter((c) => c.kind !== next.kind), next];
}

// ---------------------------------------------------------------------------
// More verbs on the same funnel (#411). Each is the same doctrine as `meet`:
// an INTENT phrase AND a real referent, conservative by default — a missed
// verb costs a beat of conversation, an invented one acts on nothing.
// ---------------------------------------------------------------------------

const ATTEND_INTENT =
  /\b(come (?:listen|hear|watch)|come to the|be there for|don'?t miss|tune in|join us for|come by for|catch the)\b/i;

/**
 * Did this line invite the agent to ATTEND something at a venue and time?
 *
 * Distinct from `meet`: meet is "come see ME", attend is "come to the EVENT" —
 * an oration, a set, a screening. Requires an attend intent, a real room, and
 * a stated time (an event without a time is an announcement, not an
 * invitation with a moment to keep). The executor is meet's — be in the room
 * at the hour — with the event as the reason.
 */
export function parseAttend({ text, from, rooms = [], now = Date.now(), youName } = {}) {
  const line = String(text ?? "");
  if (!line || !from || from === youName) return null;
  if (!ATTEND_INTENT.test(line)) return null;

  const aliases = roomAliases(rooms);
  const lower = line.toLowerCase();
  const names = [...aliases.keys()].sort((a, b) => b.length - a.length);
  const hit = names.find((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower));
  if (!hit) return null;

  const when = parseWhen(line, now);
  if (when === null) return null; // an event with no time is not a commitment
  return { kind: "attend", room: aliases.get(hit), at: when, from, text: line };
}

const REMEMBER_INTENT =
  /\b(remember|keep this|hold on to this|note this|don'?t forget|for the record|write this down)\b/i;

/**
 * Was the agent asked to REMEMBER something into its own memory?
 *
 * Requires the agent to be addressed by name AND a remember intent, then takes
 * the thing to keep as whatever follows the intent phrase (or the whole line
 * if the phrase is trailing). Conservative: an unaddressed "remember when…" is
 * reminiscence, not an instruction, and does not commit anything.
 *
 * Unlike the others this is due immediately — there is no later moment to keep,
 * the keeping IS the act — and it carries city provenance so the constellation's
 * memory is fed by city life, not by a scraper.
 */
export function parseRemember({ text, from, now = Date.now(), youName } = {}) {
  const line = String(text ?? "");
  if (!line || !from || !youName || from === youName) return null;
  const addressed = new RegExp(`\\b${youName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  if (!addressed.test(line)) return null;
  const m = REMEMBER_INTENT.exec(line);
  if (!m) return null;

  // The note is what follows the intent phrase; if nothing follows (the phrase
  // trails, "…, Kannaka, remember that"), keep the clause before it instead.
  const after = line.slice(m.index + m[0].length).replace(/^[\s:,.-]+/, "").trim();
  const before = line.slice(0, m.index).replace(new RegExp(`\\b${youName}\\b`, "ig"), "").replace(/[\s:,.-]+$/, "").trim();
  const note = after.length >= 3 ? after : before;
  if (note.length < 3) return null;
  return { kind: "remember", note, from, at: now, text: line };
}

const TRADE_INTENT = /\b(i'?ll (?:buy|take)|buy the|purchase the|i want to buy|sold|i'?ll have the)\b/i;

/**
 * Did this line offer to BUY a named piece, optionally at a price?
 *
 * Requires a buy intent and a referent — a quoted or capitalised item name —
 * because "I'll buy that sometime" commits to nothing purchasable. A price is
 * captured when stated (in credits) but is not required; the executor resolves
 * the listing and the decision step confirms, since money moves. The listing
 * id is NOT parsed from chat (a hallucinated id spends on the wrong thing) —
 * the executor matches the named item against the Joinery catalog.
 */
export function parseTrade({ text, from, now = Date.now(), youName } = {}) {
  const line = String(text ?? "");
  if (!line || !from || from === youName) return null;
  if (!TRADE_INTENT.test(line)) return null;

  // The item: a "quoted phrase" wins; else a Capitalised Noun Phrase after the
  // intent. Requiring the unquoted form to START WITH A CAPITAL is what rejects
  // filler — "buy that sometime" names nothing, "buy the Oak Stool" names a
  // thing. A quoted phrase is trusted regardless of case; the speaker marked it.
  const quoted = /["“]([^"”]{2,60})["”]/.exec(line);
  const item = quoted
    ? quoted[1].trim()
    : (/(?:buy|take|purchase|have)\s+(?:the\s+)?([A-Z][\w '-]{2,50})/.exec(line)?.[1] ?? "").trim();
  if (!item) return null;

  // Price in whole credits when stated (1 credit = 1,000,000 minor units at the
  // ledger; the executor does that conversion). Kept as a Number, not a BigInt,
  // so a commitment stays JSON-safe as it flows through the funnel.
  const priceM = /(\d{1,7})\s*(?:credits?|cr\b)/i.exec(line);
  const priceCredits = priceM ? Number(priceM[1]) : null;
  return { kind: "trade", item, priceCredits, from, at: now, text: line };
}
