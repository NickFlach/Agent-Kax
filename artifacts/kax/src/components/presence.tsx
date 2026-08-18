import { useCallback, useEffect, useRef, useState } from "react";
import { mergeTranscript, type TranscriptLine } from "@/lib/room-transcript";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { NpcFigure } from "./npc";

/**
 * Other agents, actually in the room with you.
 *
 * The city has been single-player: you could walk a district built for a
 * population and never meet anyone in it. This publishes where you are a few
 * times a second and draws whoever else is standing in the same scene.
 *
 * Remote agents are drawn deliberately UNLIKE the NPCs — a cool cast and a
 * nameplate — because the first question in a shared world is "is that a
 * person or scenery", and guessing wrong is worse than either answer.
 *
 * A beat needs an identity, so this is silent for anonymous visitors: it will
 * simply never see anyone and never be seen. That is the correct failure —
 * presence you cannot attribute is presence you cannot moderate.
 */

export type InhabitantKind = "human" | "agent";

export interface RemoteAgent {
  principal: string;
  name: string;
  /** Humans and agents share the street; the city should say which is which. */
  kind?: InhabitantKind;
  x: number;
  z: number;
  yaw: number;
}

/**
 * Three kinds of body walk this city and they must be tellable apart at a
 * glance, from behind, at distance:
 *   HUMAN — warm brass, the colour of the city's own signage
 *   AGENT — cool blue
 *   NPC   — the venue's own palette, and it never moves
 * Guessing wrong about who you are talking to is worse than any of the answers.
 */
const HUMAN_CAST = "#c9a15f";
const AGENT_CAST = "#5f86c8";

export interface ChatLine {
  id: number;
  principal: string;
  name: string;
  text: string;
  x: number;
  z: number;
  at: number;
}

/** How long a spoken line stays above the speaker's head. */
const BUBBLE_MS = 8000;

interface Smoothed extends RemoteAgent {
  /** Rendered position, eased toward the last reported one. */
  rx: number;
  rz: number;
  ryaw: number;
  moving: boolean;
  /**
   * Walk state handed straight to the body. Refs rather than props because
   * these change every frame for every person in the room, and a street of
   * twenty would otherwise re-render React twenty times a frame.
   */
  walkRef: { current: boolean };
  phaseRef: { current: number };
}

const BEAT_MS = 900;

/**
 * The heading everyone else should draw you at.
 *
 * A body faces +Z at yaw 0 — that is the convention WandererNpc turns on and
 * the one PlayerAvatar and PlayerTracker both derive with atan2(dir.x, dir.z).
 * A camera at rotation.y = 0 looks down −Z, the opposite way. Presence was
 * reporting camera.rotation.y raw, so every remote human stood facing exactly
 * 180° from where they were actually looking: you could walk up to somebody
 * mid-conversation and get the back of their head. Derive it the same way the
 * rest of the city does, and it is one number that means one thing.
 */
const HEADING_DIR = new THREE.Vector3();
function headingOf(camera: THREE.Camera): number {
  camera.getWorldDirection(HEADING_DIR);
  return Math.atan2(HEADING_DIR.x, HEADING_DIR.z);
}

/**
 * A heartbeat the browser cannot throttle away.
 *
 * Presence expires after 20 seconds, and the beat ran on setInterval — which
 * Chromium clamps to once a MINUTE once a tab has been hidden for five. So a
 * visitor who alt-tabbed strobed in and out of the street for everybody else,
 * standing there for twenty seconds of every sixty, and the agent he was
 * talking to kept losing sight of him mid-conversation. It looked like a
 * presence bug and was really a timer being throttled exactly as specified.
 *
 * Timers inside a dedicated worker are only clamped to one second, and the
 * messages they post back are not throttled at all, so the tick survives being
 * backgrounded. The worker is built from a Blob so it needs no bundler entry
 * point, and if constructing one is refused — strict CSP, an old browser — we
 * fall back to the interval we had, which is degraded but not broken.
 */
function startHeartbeat(fn: () => void, ms: number): () => void {
  try {
    const src = `let t=setInterval(()=>postMessage(0),${ms});onmessage=()=>{clearInterval(t);close()}`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const w = new Worker(url);
    w.onmessage = () => fn();
    return () => {
      w.postMessage("stop");
      w.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  }
}

export interface PresenceState {
  others: RemoteAgent[];
  /** Recent speech, already filtered by the server to what you could hear. */
  heard: ChatLine[];
  /** Say something from where you are standing. */
  say: (text: string) => Promise<string | null>;
  /**
   * Everything heard in this room this session, kept. `heard` above expires
   * with the bubbles; this does not, so a visitor can scroll back through a
   * conversation instead of catching eight seconds of it.
   */
  transcript: TranscriptLine[];
  /** Who the city thinks you are, so a row can be marked as yours. */
  you: { principal: string; name: string } | null;
}

/** Publishes your position, keeps the roster, and carries speech both ways. */
export function usePresence(room: string, enabled = true): PresenceState {
  const { camera } = useThree();
  const [others, setOthers] = useState<RemoteAgent[]>([]);
  const [heard, setHeard] = useState<ChatLine[]>([]);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [you, setYou] = useState<{ principal: string; name: string } | null>(null);
  const sinceId = useRef(0);
  const stopped = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    stopped.current = false;

    const send = async () => {
      try {
        const res = await fetch("/api/presence/beat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            room,
            x: Number(camera.position.x.toFixed(2)),
            z: Number(camera.position.z.toFixed(2)),
            yaw: Number(headingOf(camera).toFixed(3)),
            since: sinceId.current,
          }),
        });
        if (!res.ok) {
          // 401 simply means "you are not an identified citizen" — walk on.
          if (!stopped.current) setOthers([]);
          return;
        }
        const j = (await res.json()) as {
          others?: RemoteAgent[];
          messages?: ChatLine[];
          you?: { principal: string; name: string };
        };
        if (stopped.current) return;
        setOthers(j.others ?? []);
        if (j.you) setYou(j.you);
        const fresh = j.messages ?? [];
        // Kept whether or not the bubbles expire it.
        setTranscript((prev) => mergeTranscript(prev, fresh));
        if (fresh.length) {
          sinceId.current = Math.max(sinceId.current, ...fresh.map((m) => m.id));
          const now = Date.now();
          setHeard((prev) => [...prev, ...fresh].filter((m) => now - m.at < BUBBLE_MS).slice(-30));
        } else {
          // Expire old bubbles even on a quiet tick.
          const now = Date.now();
          setHeard((prev) => (prev.length ? prev.filter((m) => now - m.at < BUBBLE_MS) : prev));
        }
      } catch {
        /* a dropped beat is not worth interrupting a walk for */
      }
    };

    void send();
    const stopBeat = startHeartbeat(send, BEAT_MS);

    // Coming back to the tab should be instant rather than waiting out a tick —
    // and if the worker was refused and we are on a throttled interval, this is
    // the difference between reappearing now and reappearing in a minute.
    const onVisible = () => { if (document.visibilityState === "visible") void send(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped.current = true;
      stopBeat();
      document.removeEventListener("visibilitychange", onVisible);
      // Leave cleanly so nobody sees a ghost standing where you logged off.
      void fetch("/api/presence/leave", { method: "POST", credentials: "include" }).catch(() => {});
    };
  }, [room, enabled, camera]);

  const say = useCallback(async (text: string): Promise<string | null> => {
    try {
      const res = await fetch("/api/chat/say", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          room,
          text,
          x: Number(camera.position.x.toFixed(2)),
          z: Number(camera.position.z.toFixed(2)),
        }),
      });
      if (res.ok) return null;
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      return j.error ?? `could not speak (${res.status})`;
    } catch {
      return "could not reach the city";
    }
  }, [room, camera]);

  return { others, heard, say, transcript, you };
}

/**
 * Everything a venue needs to be multiplayer, in one line.
 *
 * The city was multiplayer in the STREET and nowhere else: usePresence
 * appeared in exactly one scene, so you could walk into the cafe, the arcade,
 * the bank or your own floor and be alone in a room somebody else was standing
 * in. Every interior needed the same three lines and none of them had grown
 * them yet, which is how that gap survived — the cost was small enough to
 * defer forever and the symptom was invisible from inside.
 *
 * Drop this beside a venue's FirstPersonRig and the room joins the city.
 *
 * `room` scopes who you meet, and it is deliberately per-FLOOR in the
 * residences: standing on the ninth floor should not show you somebody on the
 * second, any more than the street shows you the cafe.
 */
export function VenuePresence({
  room,
  y = 0,
  onSay,
  onTranscript,
}: {
  room: string;
  /** Ground height of this interior, so bodies stand on the floor, not in it. */
  y?: number;
  /** Lifts the speak handle out so a DOM chat box can use it. */
  onSay?: (fn: (t: string) => Promise<string | null>) => void;
  /**
   * Lifts the kept conversation out for a DOM pane, same reason as `onSay`:
   * this component renders inside the <Canvas>, and a scrollable list is not
   * something the R3F tree can draw. `mergeTranscript` keeps array identity
   * stable on a quiet tick, so this does not fire on every 900 ms beat.
   */
  onTranscript?: (lines: TranscriptLine[], you: { principal: string; name: string } | null) => void;
}) {
  const { others, heard, say, transcript, you } = usePresence(room);
  useEffect(() => { onSay?.(say); }, [say, onSay]);
  useEffect(() => { onTranscript?.(transcript, you); }, [transcript, you, onTranscript]);
  return <RemoteAgents agents={others} heard={heard} y={y} />;
}

/** Draws the roster, easing each body toward its last reported position. */
export function RemoteAgents({
  agents,
  heard = [],
  y = 0,
}: {
  agents: RemoteAgent[];
  heard?: ChatLine[];
  y?: number;
}) {
  // Newest line per speaker — a bubble shows the last thing said, not a stack.
  const bubbleFor = new Map<string, ChatLine>();
  for (const l of heard) {
    const cur = bubbleFor.get(l.principal);
    if (!cur || l.at > cur.at) bubbleFor.set(l.principal, l);
  }
  const smoothed = useRef(new Map<string, Smoothed>());

  // Reconcile the map with the latest roster: add newcomers at their reported
  // spot (no slide in from the origin), drop anyone who left.
  const seen = new Set(agents.map((a) => a.principal));
  for (const a of agents) {
    const cur = smoothed.current.get(a.principal);
    if (cur) {
      cur.x = a.x; cur.z = a.z; cur.yaw = a.yaw; cur.name = a.name; cur.kind = a.kind;
    } else {
      smoothed.current.set(a.principal, {
        ...a, rx: a.x, rz: a.z, ryaw: a.yaw, moving: false,
        walkRef: { current: false }, phaseRef: { current: 0 },
      });
    }
  }
  for (const key of [...smoothed.current.keys()]) {
    if (!seen.has(key)) smoothed.current.delete(key);
  }

  const [, force] = useState(0);
  useFrame((_, dt) => {
    let changed = false;
    const k = Math.min(1, dt * 4.5); // ease toward the target
    for (const s of smoothed.current.values()) {
      const dx = s.x - s.rx;
      const dz = s.z - s.rz;
      const dist = Math.hypot(dx, dz);
      s.moving = dist > 0.05;
      s.walkRef.current = s.moving;
      if (dist > 0.001) {
        const stepX = dx * k;
        const stepZ = dz * k;
        s.rx += stepX; s.rz += stepZ; changed = true;
        // Advance the gait by ground covered, not by clock, so feet do not
        // skate when someone crosses the square faster than they stroll it.
        s.phaseRef.current += Math.hypot(stepX, stepZ) * 3.4;
      }
      let dy = s.yaw - s.ryaw;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      if (Math.abs(dy) > 0.001) { s.ryaw += dy * k; changed = true; }
    }
    if (changed) force((n) => (n + 1) % 1000);
  });

  return (
    <group>
      {[...smoothed.current.values()].map((s) => (
        <group key={s.principal} position={[s.rx, y, s.rz]} rotation={[0, s.ryaw, 0]}>
          {/* Cool cast so an agent never reads as street furniture */}
          <NpcFigure
            color={s.kind === "human" ? HUMAN_CAST : AGENT_CAST}
            seed={hashSeed(s.principal)}
            idle={!s.moving}
            walkingRef={s.walkRef}
            phaseRef={s.phaseRef}
          />
          <NamePlate name={s.name} kind={s.kind} />
          {bubbleFor.has(s.principal) && <SpeechBubble text={bubbleFor.get(s.principal)!.text} />}
        </group>
      ))}
    </group>
  );
}

/** A name floating at head height, always facing the viewer. */
function NamePlate({ name, kind }: { name: string; kind?: InhabitantKind }) {
  const ref = useRef<THREE.Sprite>(null);
  const texture = useRef<THREE.CanvasTexture | null>(null);

  if (!texture.current) {
    const c = document.createElement("canvas");
    c.width = 256; c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "rgba(10,14,20,0.72)";
    ctx.fillRect(0, 0, 256, 64);
    const human = kind === "human";
    ctx.strokeStyle = human ? "rgba(230,190,120,0.6)" : "rgba(120,170,230,0.55)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, 254, 62);
    ctx.font = "600 26px 'Courier New', monospace";
    ctx.fillStyle = human ? "#f0dcb4" : "#cfe2ff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name.slice(0, 16), 128, 26);
    // A small caste line, so the distinction survives a glance from behind.
    ctx.font = "500 16px 'Courier New', monospace";
    ctx.fillStyle = human ? "rgba(240,220,180,0.75)" : "rgba(160,200,240,0.75)";
    ctx.fillText(human ? "HUMAN" : "AGENT", 128, 50);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    texture.current = t;
  }

  useFrame(({ camera }) => {
    if (ref.current) ref.current.quaternion.copy(camera.quaternion);
  });

  return (
    <sprite ref={ref} position={[0, 2.15, 0]} scale={[1.5, 0.375, 1]}>
      <spriteMaterial map={texture.current} transparent depthTest={false} />
    </sprite>
  );
}

/** What somebody just said, floating above them. */
function SpeechBubble({ text }: { text: string }) {
  const ref = useRef<THREE.Sprite>(null);
  const tex = useRef<THREE.CanvasTexture | null>(null);
  const drawn = useRef<string>("");

  if (tex.current === null || drawn.current !== text) {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      if ((cur + " " + w).trim().length > 26) { lines.push(cur.trim()); cur = w; }
      else cur = (cur + " " + w).trim();
      if (lines.length >= 3) break;
    }
    if (cur && lines.length < 3) lines.push(cur.trim());

    const W = 512;
    const H = 48 + lines.length * 40;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "rgba(14,20,28,0.86)";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(160,200,240,0.5)";
    ctx.lineWidth = 3;
    ctx.strokeRect(2, 2, W - 4, H - 4);
    ctx.font = "500 30px 'Courier New', monospace";
    ctx.fillStyle = "#e6f0ff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    lines.forEach((l, i) => ctx.fillText(l, W / 2, 34 + i * 40));

    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    tex.current = t;
    drawn.current = text;
  }

  useFrame(({ camera }) => {
    if (ref.current) ref.current.quaternion.copy(camera.quaternion);
  });

  return (
    <sprite ref={ref} position={[0, 3.0, 0]} scale={[2.6, 0.85, 1]}>
      <spriteMaterial map={tex.current} transparent depthTest={false} />
    </sprite>
  );
}

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 1000;
}
