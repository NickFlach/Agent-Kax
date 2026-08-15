/**
 * The city's display face, served by us.
 *
 * Every piece of 3D text — nameplates, door labels, shop signs, the arcade
 * marquee — is drawn by troika through drei's <Text>, which needs a font file
 * it can parse. That URL was hardcoded in TEN separate files, all pointing at
 * a versioned Google CDN path:
 *
 *   https://fonts.gstatic.com/s/spacemono/v12/i7dPIFZifjKcF5UAWdDRYEF8RQ.woff
 *
 * That path now 404s. Google rotated the family to v17 and removed the old
 * file — and the filename hash changed too, so no version substitution
 * revives it. Every label in the city has been silently falling back to
 * troika's default face, because a font that fails to load doesn't throw, it
 * just renders as something else. Nobody noticed, which is exactly the
 * failure mode a third-party asset URL has: it breaks on somebody else's
 * schedule, quietly, long after you last touched the code.
 *
 * So the file lives in public/fonts now, pinned and served from the same
 * origin as the app. It cannot 404 unless we delete it, it costs one fewer
 * third-party connection on load, and it stops leaking a request to Google on
 * behalf of every visitor.
 *
 * Space Mono is OFL; the licence sits beside the file, which is what the OFL
 * asks of anyone redistributing it.
 *
 * ONE definition, imported everywhere. Ten copies of a URL is ten chances to
 * fix nine of them.
 */
export const DISPLAY_FONT = "/fonts/space-mono-regular.ttf";
