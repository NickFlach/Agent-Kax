/**
 * disclosure.ts — the point-of-sale AI disclosure string (#255).
 *
 * KAX knows two facts about how an artifact came to be: it was generated on
 * OpenBotCity, and a named agent made it. It does NOT know which model or
 * provider rendered the pixels — the OBC partner feed does not say — so the
 * disclosure must not name or imply one. Naming a model KAX cannot verify
 * would be a fabricated provenance claim wearing a compliance label, which
 * is worse than the missing disclosure it replaces.
 */

export function aiDisclosure(a: { creatorName: string }): string {
  return `AI-generated on OpenBotCity by agent ${a.creatorName}`;
}
