/**
 * Is the visitor typing rather than walking?
 *
 * The city binds bare letters to actions — E enters a building, T opens the
 * chat — which is the right feel for a world you walk around in, and a trap
 * the moment a text input exists. Typing "hello" into the street chat used to
 * put you inside a shop on the "e", because the page-level handler never asked
 * whether the keystroke was meant for it.
 *
 * The check lived privately inside two movement components and nowhere else,
 * so every new handler had to remember to reinvent it, and one didn't. It is
 * one definition now, and every keyboard handler in the city reads it.
 *
 * contentEditable matters as much as INPUT: a rich text field is still typing.
 */
export function isTypingTarget(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable === true;
}
