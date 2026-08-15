import { useEffect, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { NpcFigure } from "./npc";
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

const TALK_RANGE = 4.2;

/** Draws the figure, watches the distance, and offers the prompt. */
export function TalkableNpc({
  position,
  rotation = 0,
  color,
  seed,
  name,
  onRangeChange,
  active,
}: {
  position: [number, number, number];
  rotation?: number;
  color: string;
  seed: number;
  name: string;
  /** Called when the visitor comes into or leaves talking range. */
  onRangeChange: (inRange: boolean) => void;
  /** True while this NPC is the one being talked to. */
  active: boolean;
}) {
  const inRange = useRef(false);
  const sprite = useRef<THREE.Sprite>(null);
  const tex = useRef<THREE.CanvasTexture | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  if (!tex.current) {
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
    ctx.fillText("[ E ] TALK", 256, 68);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    tex.current = t;
  }

  useFrame(({ camera }) => {
    const dx = camera.position.x - position[0];
    const dz = camera.position.z - position[2];
    const near = Math.hypot(dx, dz) < TALK_RANGE;
    if (near !== inRange.current) {
      inRange.current = near;
      setShowPrompt(near);
      onRangeChange(near);
    }
    if (sprite.current) sprite.current.quaternion.copy(camera.quaternion);
  });

  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <NpcFigure color={color} seed={seed} />
      {(showPrompt || active) && (
        <sprite ref={sprite} position={[0, 2.35, 0]} scale={[1.9, 0.36, 1]}>
          <spriteMaterial map={tex.current} transparent depthTest={false} />
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
