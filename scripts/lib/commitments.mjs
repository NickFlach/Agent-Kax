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
