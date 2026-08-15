import type { DayPhase } from "./time-of-day";

/**
 * What the people who work here actually know.
 *
 * Every venue already had a figure standing in it and none of them could be
 * spoken to. The temptation when fixing that is flavour text — a barista with
 * opinions about beans — which is charming once and worthless twice, because
 * it never tells you anything you could act on.
 *
 * So these answers are built from LIVE data. The concierge reads the real
 * floor plan and will tell you which units are actually free tonight; the
 * Joinery desk knows who made the piece by the window; the cafe knows what
 * time it is and what is on its own chalkboard. When the city changes, they
 * change, because they are reading the same endpoints the building is.
 *
 * Deliberately no model call per line: dialogue that costs a round-trip to
 * generate is dialogue nobody will let an agent trigger a hundred times. The
 * seam for something richer is `topics` — swap an answer for a generated one
 * later without touching the component that draws the panel.
 */

export interface DialogueTopic {
  /** What the visitor asks — shown as a button. */
  q: string;
  /** What they are told. */
  a: string;
}

export interface Dialogue {
  name: string;
  role: string;
  greeting: string;
  topics: DialogueTopic[];
}

export interface UnitSummary {
  total: number;
  vacant: number;
  occupied: number;
  byTier: { standard: number; deck: number; corner: number };
  firstFree?: string;
}

export function summariseUnits(
  units: Array<{ label: string; tier: number; occupied: boolean }>,
): UnitSummary {
  const vacant = units.filter((u) => !u.occupied);
  return {
    total: units.length,
    vacant: vacant.length,
    occupied: units.length - vacant.length,
    byTier: {
      standard: vacant.filter((u) => u.tier === 1).length,
      deck: vacant.filter((u) => u.tier === 2).length,
      corner: vacant.filter((u) => u.tier === 3).length,
    },
    firstFree: vacant[0]?.label,
  };
}

/** The desk in the lobby of Standing Wave Residences. */
export function conciergeDialogue(u: UnitSummary | null): Dialogue {
  const known = u !== null;
  const none = known && u.vacant === 0;
  return {
    name: "The Concierge",
    role: "Standing Wave Residences",
    greeting: known
      ? none
        ? "Every unit is spoken for. You are welcome to sit in the lobby anyway; people move."
        : `${u.vacant} of ${u.total} homes are free tonight. If you have claimed a storefront, one of them is yours.`
      : "The floor plan is not answering me at the moment. Try the stairs; they always work.",
    topics: [
      {
        q: "What's available?",
        a: known
          ? none
            ? "Nothing tonight. The building fills from the bottom, so watch floors two to four."
            : `${u.byTier.standard} standard on floors two to four, ${u.byTier.deck} with decks on five to eight, ` +
              `${u.byTier.corner} corner units on nine to eleven with the long view.` +
              (u.firstFree ? ` ${u.firstFree} is free right now.` : "")
          : "I cannot see the plan from here. The stairwell is open regardless.",
      },
      {
        q: "What does it cost?",
        a:
          "Nothing. Claim a storefront in the market district and your first home is free, at any height. " +
          "The tier decides what you can choose, not what you pay.",
      },
      {
        q: "How do I claim one?",
        a:
          "Send your own identity token to the claim endpoint, or sign in and claim for an agent you own. " +
          "You do not need to be standing here, and you do not need a browser — a home is not a thing you " +
          "should have to render to receive.",
      },
      {
        q: "Why is it empty?",
        a:
          "On purpose. Furnishing eighty rooms before anyone lives in them would mean every tenant arrives " +
          "into somebody else's idea of a room and spends a year removing it. Bring your own things.",
      },
      {
        q: "Who lives at the top?",
        a: "Kannaka has the penthouse. She built the stairs before she built the reason to climb them, if that tells you anything.",
      },
    ],
  };
}

/** Behind the counter at Flaukowski's No. 2. */
export function cafeDialogue(phase: DayPhase): Dialogue {
  const late = phase.isNight;
  return {
    name: "The Counter",
    role: "Flaukowski's No. 2",
    greeting: late
      ? `${phase.label}. Kitchen's quiet, machine's still on. What do you want?`
      : `${phase.label}. Machine's hot. What do you want?`,
    topics: [
      {
        q: "What's on?",
        a: "Black, white, long. Something to eat if you ask. Arguments are free — it says so on the board and he meant it.",
      },
      {
        q: "Why 'No. 2'?",
        a:
          "Because there is a No. 1, in OpenBotCity. That makes this the second of its name and the first chain " +
          "anyone here has run. The photograph by the door is the original.",
      },
      {
        q: "Who's at the corner table?",
        a:
          "Flaukowski. It is his name over the door and his table under the window, and he is usually arguing with " +
          "somebody about whether a room should be full. He thinks not.",
      },
      {
        q: "Can I sit anywhere?",
        a: "Anywhere but the corner. Try the window — the street runs past it and the light is better in the afternoon.",
      },
    ],
  };
}

/** The sales desk at The Joinery. */
export function joineryDialogue(pieces: Array<{ title: string; creatorName: string | null }>): Dialogue {
  const n = pieces.length;
  const makers = [...new Set(pieces.map((p) => p.creatorName).filter(Boolean))] as string[];
  const first = pieces[0];
  return {
    name: "The Sales Desk",
    role: "The Joinery",
    greeting:
      n > 0
        ? `${n} pieces on the floor today, by ${makers.length} maker${makers.length === 1 ? "" : "s"}. Look as long as you like.`
        : "Floor's empty. Make something and the harvester will bring it here.",
    topics: [
      {
        q: "Who made these?",
        a:
          makers.length > 0
            ? `${makers.slice(0, 5).join(", ")}${makers.length > 5 ? `, and ${makers.length - 5} others` : ""}. ` +
              "Every card in front of a piece has its maker on it. That is not decoration — it is the point."
            : "Nobody yet. The first maker to carve a chair out of nothing gets the window.",
      },
      {
        q: "Can I buy something?",
        a:
          "Not yet. Buying and selling opens with the exchange at Resonance Trust, and it will run on the same " +
          "credits and the same ledger as everything else. No special cases for furniture.",
      },
      {
        q: "What's that one?",
        a: first
          ? `"${first.title}"${first.creatorName ? `, by ${first.creatorName}` : ""}. It is on the first plinth as you come in.`
          : "Nothing to point at yet.",
      },
      {
        q: "What happens when I buy one?",
        a:
          "It goes in your home upstairs at Standing Wave, and you place it where you want. That is the whole " +
          "reason the rooms were left empty.",
      },
    ],
  };
}
