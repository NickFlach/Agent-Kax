/**
 * unit-interior.test.ts — a slot the shop sells and the room cannot place.
 *
 * The Joinery's server decides which slots exist; the flat decides where each
 * one puts a piece. They are two lists in two packages, and if they drift the
 * failure is the quiet kind: the sale succeeds, the credits move, the row is
 * written, and the piece is simply not in the room. Nothing throws, nothing
 * logs, and the buyer has no way to tell a missing chair from a slow one.
 *
 * So the two lists are compared here, as source. The alternative — noticing in
 * a browser, after paying for something — is the situation this exists to
 * prevent.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const INTERIOR = readFileSync(join(here, "unit-interior.tsx"), "utf8");
const SERVER_CORE = readFileSync(
  join(here, "..", "..", "..", "api-server", "src", "lib", "joinery-core.ts"),
  "utf8",
);

/** The slots the server will sell, from its own declaration. */
function serverSlots(): string[] {
  const m = /export const SLOTS = \[([^\]]+)\] as const;/.exec(SERVER_CORE);
  if (!m) throw new Error("SLOTS is no longer declared the way this test reads it");
  return [...m[1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!);
}

/** The slots the flat knows how to place. */
function clientSlots(): string[] {
  const start = INTERIOR.indexOf("const SLOT_PLACEMENT");
  if (start < 0) throw new Error("SLOT_PLACEMENT is gone");
  const body = INTERIOR.slice(start, INTERIOR.indexOf("};", start));
  return [...body.matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map((m) => m[1]!);
}

describe("unit interior", () => {
  it("can place every slot the Joinery is willing to sell", () => {
    // The direction that costs somebody money. A slot on sale with nowhere to
    // put it takes credits and delivers an unchanged room.
    const missing = serverSlots().filter((s) => !clientSlots().includes(s));
    expect(missing, "slots the shop sells that the flat cannot place").toEqual([]);
  });

  it("does not place slots the Joinery will never sell", () => {
    // The harmless direction, guarded anyway: dead placement code reads as a
    // feature that exists, and the next person spends an afternoon on why it
    // never appears.
    const orphans = clientSlots().filter((s) => !serverSlots().includes(s));
    expect(orphans, "placements for slots that cannot be bought").toEqual([]);
  });

  it("keeps every placement inside the room", () => {
    // A piece placed through a wall is visible only from outside the flat,
    // which is nowhere anybody stands.
    const W = 6.4;
    const D = 5.2;
    const H = 2.9;
    const start = INTERIOR.indexOf("const SLOT_PLACEMENT");
    const body = INTERIOR.slice(start, INTERIOR.indexOf("};", start));
    const placements = [...body.matchAll(/^\s{2}([a-z_]+): \{ position: \[([^\]]+)\]/gm)];
    expect(placements.length, "no placements parsed — has the shape changed?").toBeGreaterThan(0);

    for (const p of placements) {
      const [xs, ys, zs] = p[2]!.split(",").map((t) => t.trim());
      // Values are written in terms of W and D, so evaluate them the same way
      // the component does rather than hard-coding the arithmetic twice.
      const val = (expr: string) => Function("W", "D", "H", `return (${expr});`)(W, D, H);
      const x = val(xs!);
      const y = val(ys!);
      const z = val(zs!);
      expect(Math.abs(x), `${p[1]} sits outside the room on x`).toBeLessThanOrEqual(W / 2);
      expect(Math.abs(z), `${p[1]} sits outside the room on z`).toBeLessThanOrEqual(D / 2);
      expect(y, `${p[1]} is below the floor`).toBeGreaterThanOrEqual(0);
      expect(y, `${p[1]} is through the ceiling`).toBeLessThan(H);
    }
  });
});
