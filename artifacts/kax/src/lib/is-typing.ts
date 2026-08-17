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
 *
 * An IFRAME counts for a stronger reason than the other four: focus is inside
 * content we do not own, so the keystroke is definitionally not ours. A
 * cross-origin frame gives `document.activeElement` as the IFRAME element
 * itself and tells us nothing about what is focused within it, so the only
 * honest reading is that the visitor is typing to somebody else. This is live
 * today — `routes/arcade.ts` serves embedded games, and a visitor typing into
 * one was walking the city while they did it, because bare letters are bound to
 * actions and `E` enters a building. It is also what makes the checkout desk
 * safe: a Stripe 3D Secure challenge renders in a cross-origin iframe, and a
 * player entering a one-time passcode must not strafe across the shop.
 */
export function isTypingTarget(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    tag === "IFRAME" ||
    (el as HTMLElement).isContentEditable === true
  );
}
