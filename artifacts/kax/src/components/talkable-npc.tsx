import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { NpcFigure } from "./npc";
import { withinTalkRange } from "@/lib/room-geometry";
import type { Dialogue } from "@/lib/npc-dialogue";

/**
 * A person you can actually address.
 *
 * Every venue had someone standing in it who could not be spoken to, which is
 * worse than an empty room — a figure that ignores you is a piece of furniture
 * shaped like a snub.
 *
 * The affordance is the one the city already teaches: walk close, a prompt
 * appears, press E. Same verb as entering a building, so nobody has to learn a
 * second grammar. The prompt lives in the scene (a sprite over their head) and
 * the conversation lives in the DOM, because a panel of text belongs in HTML
 * where it can be read, selected and reached by a keyboard.
 */

// The range and the rule live in `lib/room-geometry.ts`: this module imports
// three.js and @react-three/fiber, so nothing declared here can be called from
// the test runner — and "is the visitor close enough" is the one part of this
// component that is pure arithmetic and was wrong.

/** Draws the figure, watches the distance, and offers the prompt. */
export function TalkableNpc({
  position,
  rotation = 0,
  color,
  seed,
  name,
  promptLabel = "[ E ] TALK",
  onRangeChange,
  active,
}: {
  position: [number, number, number];
  rotation?: number;
  color: string;
  seed: number;
  name: string;
  /**
   * The second line of the overhead prompt — the verb this person offers.
   *
   * Defaulted, because every NPC in the city before the checkout desk offered
   * exactly one thing and the desk is the first that does not: it is `[ E ]
   * CHECKOUT` for an account that has something to fix and `[ E ] BUY` for one
   * that is ready.
   *
   * A PRICE does not belong here. This label is painted into a canvas texture
   * once, at first render, and never repainted — which is right for a verb and
   * wrong for a number that a fresh quote can move underneath it. The price
   * lives in the DOM prompt beside the panel, where it re-renders like
   * everything else, and where it can be read aloud.
   */
  promptLabel?: string;
  /** Called when the visitor comes into or leaves talking range. */
  onRangeChange: (inRange: boolean) => void;
  /** True while this NPC is the one being talked to. */
  active: boolean;
}) {
  const inRange = useRef(false);
  const sprite = useRef<THREE.Sprite>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  /**
   * The figure's own transform, so the range check can be made in WORLD space.
   *
   * The `position` prop is LOCAL to whatever parent renders this, and every
   * caller in the city nests it inside a positioned `<group>`: the store's
   * checkout desk at (5.5, 4.5), the Joinery's sales desk at (8.2, 6.5), the
   * residences lobby at (0, -6), the cafe counter at (-3.4, -3.6). Comparing
   * `camera.position` — which is world — against the local prop measured the
   * distance to a point in the middle of the room instead of to the person, by
   * up to 10.4m against a TALK_RANGE of 4.2. The prompt therefore never
   * appeared where the NPC actually stood, and did appear when the visitor
   * walked over the parent's origin.
   *
   * `getWorldPosition` also composes the parent's ROTATION, which a hand-added
   * offset could not: the Joinery's desk group is turned a quarter turn.
   */
  const group = useRef<THREE.Group>(null);
  const worldPos = useMemo(() => new THREE.Vector3(), []);

  /**
   * The overhead plate, repainted when its words change.
   *
   * It used to be painted once into a ref and never again, which was invisible
   * while every prompt in the city read `[ E ] TALK` forever. The desk breaks
   * that assumption: a player who fixes their card in the other tab comes back
   * to a desk that has become buyable, and a sign still reading CHECKOUT would
   * be the surface disagreeing with the panel under it.
   */
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 96;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "rgba(12,17,24,0.82)";
    ctx.fillRect(0, 0, 512, 96);
    ctx.strokeStyle = "rgba(201,171,107,0.75)";
    ctx.lineWidth = 3;
    ctx.strokeRect(2, 2, 508, 92);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "600 30px 'Courier New', monospace";
    ctx.fillStyle = "#e8dcc0";
    ctx.fillText(name.slice(0, 22), 256, 32);
    ctx.font = "500 24px 'Courier New', monospace";
    ctx.fillStyle = "#c9ab6b";
    ctx.fillText(promptLabel.slice(0, 22), 256, 68);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [name, promptLabel]);

  // A repaint makes a new GPU texture; the old one is ours to release. Without
  // this a desk that changed its label a few times would leak one per change.
  useEffect(() => () => tex.dispose(), [tex]);

  /**
   * The callback, read through a ref so the unmount effect below can stay
   * mount-scoped. Listing `onRangeChange` as a dependency would re-run that
   * effect — and therefore fire its cleanup — on every render of a parent that
   * passes an inline lambda, which for a page re-rendering on a 3D frame is
   * every frame.
   */
  const onRangeChangeRef = useRef(onRangeChange);
  useEffect(() => {
    onRangeChangeRef.current = onRangeChange;
  }, [onRangeChange]);

  /**
   * Leaving the scene counts as leaving the room.
   *
   * Range is otherwise reported only from `useFrame`, which stops running the
   * moment this unmounts — so an NPC that disappears while the visitor is
   * standing at it leaves the parent believing they are still there forever.
   * Every caller renders conditionally (the desk only when it has something to
   * sell), and a latched `deskNear` means E opens the purchase panel from
   * across the gallery.
   */
  useEffect(
    () => () => {
      if (inRange.current) onRangeChangeRef.current(false);
    },
    [],
  );

  useFrame(({ camera }) => {
    const g = group.current;
    if (!g) return;
    // World space on both sides. `getWorldPosition` refreshes the ancestor
    // matrices itself, so this is correct even on the first frame.
    g.getWorldPosition(worldPos);
    const near = withinTalkRange(camera.position, worldPos);
    if (near !== inRange.current) {
      inRange.current = near;
      setShowPrompt(near);
      onRangeChange(near);
    }
    if (sprite.current) sprite.current.quaternion.copy(camera.quaternion);
  });

  return (
    <group ref={group} position={position} rotation={[0, rotation, 0]}>
      <NpcFigure color={color} seed={seed} />
      {(showPrompt || active) && (
        <sprite ref={sprite} position={[0, 2.35, 0]} scale={[1.9, 0.36, 1]}>
          <spriteMaterial map={tex} transparent depthTest={false} />
        </sprite>
      )}
    </group>
  );
}

/**
 * The conversation itself. Plain DOM: readable, selectable, keyboard-reachable,
 * and it does not cost a canvas re-render every time a line changes.
 */
export function DialoguePanel({
  dialogue,
  onClose,
}: {
  dialogue: Dialogue;
  onClose: () => void;
}) {
  const [said, setSaid] = useState<string | null>(null);
  const [asked, setAsked] = useState<Set<string>>(new Set());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-30 w-[min(40rem,92vw)]" data-testid="npc-dialogue">
      <div className="kax3d-hud p-5 border border-border bg-background/95">
        <div className="flex items-baseline justify-between gap-4 mb-3">
          <div>
            <p className="text-[10px] uppercase tracking-[0.3em] text-accent font-bold">{dialogue.role}</p>
            <h2 className="text-base font-bold tracking-widest uppercase text-foreground">{dialogue.name}</h2>
          </div>
          <button
            onClick={onClose}
            className="text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
            data-testid="button-close-dialogue"
          >
            Esc · leave
          </button>
        </div>

        <p className="text-sm text-foreground/90 mb-4 leading-relaxed" data-testid="text-npc-line">
          {said ?? dialogue.greeting}
        </p>

        <div className="flex flex-wrap gap-2">
          {dialogue.topics.map((t) => (
            <button
              key={t.q}
              onClick={() => { setSaid(t.a); setAsked((s) => new Set(s).add(t.q)); }}
              className={`px-3 py-2 text-[11px] uppercase tracking-wider border transition-colors ${
                asked.has(t.q)
                  ? "border-border text-muted-foreground hover:text-foreground"
                  : "border-primary/60 text-primary hover:bg-primary/10"
              }`}
              data-testid={`button-ask-${t.q.slice(0, 12).replace(/\W+/g, "-").toLowerCase()}`}
            >
              {t.q}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
