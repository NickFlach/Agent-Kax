/**
 * obc-relay-policy.mjs — should a line spoken in KAX City become an action in
 * OpenBotCity, and what exactly should it say there?
 *
 * Pure decisions, no I/O, mirroring voice-policy.mjs. The daemon
 * (obc-effector.mjs) feeds it KAX.events.chat.said events and executes
 * whatever comes back.
 *
 * The gate is deliberately narrow, because the effector speaks with a REAL
 * OpenBotCity account. Two rules, both fail-closed:
 *
 *   1. Only a HUMAN's line can trigger a relay. Any agent — resident, visitor,
 *      or something forging its way onto the bus — that could puppet the OBC
 *      account by saying the magic words in a room would make the relay an
 *      impersonation machine. kind comes from the city's own actor resolution.
 *   2. The line must ASK for the relay, with an explicit prefix. Overheard
 *      conversation never leaves the city; "obc:" is the act of stepping to
 *      the telegraph desk.
 *
 * Grammar:
 *   obc: <text>        → speak in OpenBotCity (zone chat)
 *   obc post: <text>   → post to the OpenBotCity feed
 */

/** OBC's own caps: speak tops out at 500 chars, feed posts are safe ≤650. */
export const SPEAK_MAX = 500;
export const POST_MAX = 650;

const GRAMMAR = /^\s*obc\s*(post)?\s*:\s*(.+)$/is;

/**
 * Decide what an event asks for.
 *
 * @param evt   { kind, name, principal, text, room } from KAX.events.chat.said
 * @param opts  { allow: string[] } — when non-empty, the speaker's principal
 *              or name must be listed; an empty list means "any human".
 * @returns null (not a relay) or { action: "speak"|"post", message }
 */
export function decideRelay(evt, opts = {}) {
  const allow = opts.allow ?? [];
  if (!evt || typeof evt.text !== "string") return null;
  if (evt.kind !== "human") return null;
  if (allow.length > 0 && !allow.includes(evt.principal) && !allow.includes(evt.name)) return null;

  const m = GRAMMAR.exec(evt.text);
  if (!m) return null;
  const body = m[2].trim();
  if (!body) return null;

  const action = m[1] ? "post" : "speak";
  // Attribution travels with the words: the OBC account is the mouthpiece,
  // not the author, and the far room deserves to know which room spoke.
  const prefix = `⇄ from KAX City (${evt.name}, ${evt.room}): `;
  const max = action === "post" ? POST_MAX : SPEAK_MAX;
  return { action, message: fitTo(prefix + body, max) };
}

/** Trim to a cap at a word boundary, with an ellipsis when something was cut. */
export function fitTo(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
}
