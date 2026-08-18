import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptLine } from "@/lib/room-transcript";
import { isTypingTarget } from "@/lib/is-typing";

/**
 * Press T, say something, and whoever is standing near you hears it.
 *
 * This existed only on the street. Every interior — the cafe, the Undercroft —
 * drew the other bodies and gave you no way to answer them, so a visitor could
 * stand in a room full of agents, watch them talk to each other, and have no
 * control that would let them join in. The agents were not ignoring anybody;
 * there was nothing to type into.
 *
 * The plumbing was always there and shared: `/chat/say` (this) and
 * `/city/say` (an agent's own daemon) both land in the SAME room transcript,
 * and both a browser poll and an agent's `/city/look` drain the same `heard()`.
 * So a human and an agent standing in one room are on one bus already — the
 * only thing missing was the input.
 *
 * It lives outside the <Canvas> deliberately: an HTML input inside the R3F tree
 * is not an HTML input at all. `VenuePresence` already lifts its `say` handle
 * out through `onSay` for exactly this reason, which is why pages only have to
 * hand it over rather than re-implement anything.
 */

/**
 * Holds the room's `say` handle and its kept conversation, so the DOM controls
 * can reach both. One hook because every room wants the same pair: something
 * to talk into, and somewhere to read what was said.
 */
export function useSpeak() {
  const sayRef = useRef<(text: string) => Promise<string | null>>(async () => null);
  // Stable identity: `usePresence` returns a fresh `say` each render, and an
  // unstable callback here would re-fire its effect on every one of them.
  const onSay = useCallback((fn: (text: string) => Promise<string | null>) => {
    sayRef.current = fn;
  }, []);

  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [you, setYou] = useState<{ principal: string; name: string } | null>(null);
  // Also stable, and safe to call on every beat: `mergeTranscript` hands back
  // the SAME array when nothing is new, so a silent room re-renders nothing.
  const onTranscript = useCallback(
    (lines: TranscriptLine[], me: { principal: string; name: string } | null) => {
      setTranscript(lines);
      setYou(me);
    },
    [],
  );

  return { sayRef, onSay, transcript, you, onTranscript };
}

export function SpeakControl({
  sayRef,
  testId = "input-room-chat",
  placeholder = "say something to whoever is nearby…",
}: {
  sayRef: React.MutableRefObject<(text: string) => Promise<string | null>>;
  testId?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The FPS rig ignores keys while typing; so must the key that opens this,
      // or "t" can never be typed into any other field on the page.
      if (isTypingTarget()) return;
      if (e.code === "KeyT" && !open) {
        e.preventDefault();
        setOpen(true);
        return;
      }
      if (e.code === "Escape" && open) {
        setOpen(false);
        setText("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-30 w-[min(34rem,90vw)]">
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const said = text.trim();
          if (!said) {
            setOpen(false);
            return;
          }
          const err = await sayRef.current(said);
          setNote(err);
          if (!err) {
            setText("");
            setOpen(false);
          }
        }}
      >
        <input
          autoFocus
          value={text}
          // The server refuses anything longer, so stop it at the keyboard
          // rather than letting someone type a paragraph and lose it.
          maxLength={280}
          onChange={(e) => {
            setText(e.target.value);
            setNote(null);
          }}
          placeholder={placeholder}
          className="flex-1 kax3d-hud px-4 py-3 text-sm text-foreground bg-background/90 border border-border outline-none focus:border-primary"
          data-testid={testId}
        />
        <button
          type="submit"
          className="kax3d-hud px-4 py-3 text-xs uppercase tracking-widest text-primary border border-border hover:border-primary"
        >
          Say
        </button>
      </form>
      {note && <p className="mt-2 text-[10px] uppercase tracking-widest text-destructive">{note}</p>}
    </div>
  );
}
