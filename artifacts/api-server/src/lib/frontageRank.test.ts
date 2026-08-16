/**
 * frontageRank.test.ts — the 48-store cut must not land inside a tie.
 *
 * The street renders the first 48 rows of this ordering. Live, the cut falls
 * between `finn` (53 artifacts) and `uma` (53) — stores identical on every
 * measure the comparator looked at, separated by nothing.
 *
 * `Array.prototype.sort` is stable, so this is not random between calls. It is
 * worse than random in a way that is harder to notice: the order falls out of
 * whatever order Postgres returned the rows in, which carries no guarantee
 * without an ORDER BY and shifts as rows are inserted, updated or vacuumed. So
 * whether your building exists on the street is a fact about the query plan.
 * Somebody loses their frontage to an autovacuum and there is nothing to read
 * that would explain it.
 *
 * The tiebreak is therefore NOT gated — a nondeterministic cut is a bug
 * whatever anybody thinks about ranking. The ranking above it is a policy
 * choice and IS gated, and the test that matters most for it is the one
 * proving the gate is off by default.
 */

import { describe, expect, it } from "vitest";
import { compareFrontage, frontageModeFrom, rankFrontage, type RankableStorefront } from "./frontageRank";

function store(slug: string, artifactCount: number, opts: { claimed?: boolean; ingest?: number } = {}): RankableStorefront {
  return {
    agent: { slug },
    artifactCount,
    latestIngestAt: opts.ingest === undefined ? null : new Date(opts.ingest),
    claimed: opts.claimed ?? false,
  };
}

describe("frontage ranking", () => {
  it("orders a tie deterministically, whatever order it arrives in", () => {
    // The live tie: three stores on 53 with no ingest timestamp between them.
    const tie = [store("uma", 53), store("finn", 53), store("luca", 53)];
    const forwards = rankFrontage(tie).map((s) => s.agent.slug);
    const backwards = rankFrontage([...tie].reverse()).map((s) => s.agent.slug);
    const shuffled = rankFrontage([tie[1]!, tie[2]!, tie[0]!]).map((s) => s.agent.slug);

    expect(forwards).toEqual(["finn", "luca", "uma"]);
    // Same answer from any input order — that is what makes the cut a fact
    // about the data rather than about the query plan.
    expect(backwards).toEqual(forwards);
    expect(shuffled).toEqual(forwards);
  });

  it("still ranks by artifact count first", () => {
    const rows = rankFrontage([store("aaa", 1), store("zzz", 900), store("mmm", 50)]);
    expect(rows.map((s) => s.agent.slug)).toEqual(["zzz", "mmm", "aaa"]);
  });

  it("uses recency before falling back to the slug", () => {
    // The slug is a LAST resort. A store that ingested yesterday must still
    // outrank an alphabetically earlier one that ingested last year.
    const rows = rankFrontage([
      store("aaa", 10, { ingest: 1_000 }),
      store("zzz", 10, { ingest: 9_000 }),
    ]);
    expect(rows.map((s) => s.agent.slug)).toEqual(["zzz", "aaa"]);
  });

  it("is a total order — never reports two rows as equal", () => {
    // If the comparator can return 0 for two distinct stores, the cut can
    // still move. Distinct slugs are the guarantee that it cannot.
    const rows = [
      store("a", 5),
      store("b", 5),
      store("c", 5, { ingest: 10 }),
      store("d", 5, { ingest: 10, claimed: true }),
    ];
    for (const x of rows) {
      for (const y of rows) {
        if (x.agent.slug === y.agent.slug) continue;
        for (const mode of ["default", "claimed-first"] as const) {
          expect(compareFrontage(x, y, mode), `${x.agent.slug} vs ${y.agent.slug} (${mode})`).not.toBe(0);
        }
      }
    }
  });

  it("is off by default, and only the exact opt-in turns it on", () => {
    // The gate is the whole safety property: absent means today's behaviour.
    expect(frontageModeFrom({})).toBe("default");
    expect(frontageModeFrom({ KAX_FRONTAGE_RANK: "" })).toBe("default");
    expect(frontageModeFrom({ KAX_FRONTAGE_RANK: "true" })).toBe("default");
    expect(frontageModeFrom({ KAX_FRONTAGE_RANK: "Claimed-First" })).toBe("default");
    expect(frontageModeFrom({ KAX_FRONTAGE_RANK: "claimed-first" })).toBe("claimed-first");
  });

  it("changes nothing about relative order when the gate is off", () => {
    // Byte-identical to the old comparator for every input the old one
    // ordered deterministically. A claimed store does NOT jump the queue.
    const rows = [
      store("small-claimed", 3, { claimed: true }),
      store("big-unclaimed", 900),
      store("mid-unclaimed", 50),
    ];
    expect(rankFrontage(rows, "default").map((s) => s.agent.slug)).toEqual([
      "big-unclaimed",
      "mid-unclaimed",
      "small-claimed",
    ]);
  });

  it("puts claimed stores that hold work in front, under the opt-in", () => {
    const rows = [
      store("big-unclaimed", 900),
      store("small-claimed", 3, { claimed: true }),
      store("mid-unclaimed", 50),
    ];
    expect(rankFrontage(rows, "claimed-first").map((s) => s.agent.slug)).toEqual([
      "small-claimed",
      "big-unclaimed",
      "mid-unclaimed",
    ]);
  });

  it("does not promote an empty claimed store over somebody's body of work", () => {
    // "Claimed" alone would put a blank shopfront in front of 1500 pieces,
    // which is the opposite of what frontage is for.
    const rows = [store("empty-claimed", 0, { claimed: true }), store("rex", 1534)];
    expect(rankFrontage(rows, "claimed-first").map((s) => s.agent.slug)).toEqual(["rex", "empty-claimed"]);
  });

  it("keeps the cut stable when a store's count changes below it", () => {
    // The property that matters in production: the 48 buildings on the street
    // must not reshuffle because row 200 gained an artifact.
    const many = Array.from({ length: 60 }, (_, i) => store(`s${String(i).padStart(3, "0")}`, 53));
    const before = rankFrontage(many).slice(0, 48).map((s) => s.agent.slug);
    const after = rankFrontage(
      many.map((s) => (s.agent.slug === "s059" ? store("s059", 54) : s)),
    )
      .slice(0, 48)
      .map((s) => s.agent.slug);
    // s059 climbs to the top; everything else keeps its relative order, and
    // exactly one store falls off the end rather than the street reshuffling.
    expect(after[0]).toBe("s059");
    expect(after.slice(1)).toEqual(before.slice(0, 47));
  });
});
