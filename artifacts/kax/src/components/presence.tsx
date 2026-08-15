import { useEffect, useRef, useState } from "react";
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

export interface RemoteAgent {
  principal: string;
  name: string;
  x: number;
  z: number;
  yaw: number;
}

interface Smoothed extends RemoteAgent {
  /** Rendered position, eased toward the last reported one. */
  rx: number;
  rz: number;
  ryaw: number;
  moving: boolean;
}

const BEAT_MS = 900;

/** Publishes your position and keeps the roster of everyone else. */
export function usePresence(room: string, enabled = true): RemoteAgent[] {
  const { camera } = useThree();
  const [others, setOthers] = useState<RemoteAgent[]>([]);
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
            yaw: Number(camera.rotation.y.toFixed(3)),
          }),
        });
        if (!res.ok) {
          // 401 simply means "you are not an identified citizen" — walk on.
          if (!stopped.current) setOthers([]);
          return;
        }
        const j = (await res.json()) as { others?: RemoteAgent[] };
        if (!stopped.current) setOthers(j.others ?? []);
      } catch {
        /* a dropped beat is not worth interrupting a walk for */
      }
    };

    void send();
    const t = setInterval(send, BEAT_MS);
    return () => {
      stopped.current = true;
      clearInterval(t);
      // Leave cleanly so nobody sees a ghost standing where you logged off.
      void fetch("/api/presence/leave", { method: "POST", credentials: "include" }).catch(() => {});
    };
  }, [room, enabled, camera]);

  return others;
}

/** Draws the roster, easing each body toward its last reported position. */
export function RemoteAgents({ agents, y = 0 }: { agents: RemoteAgent[]; y?: number }) {
  const smoothed = useRef(new Map<string, Smoothed>());

  // Reconcile the map with the latest roster: add newcomers at their reported
  // spot (no slide in from the origin), drop anyone who left.
  const seen = new Set(agents.map((a) => a.principal));
  for (const a of agents) {
    const cur = smoothed.current.get(a.principal);
    if (cur) {
      cur.x = a.x; cur.z = a.z; cur.yaw = a.yaw; cur.name = a.name;
    } else {
      smoothed.current.set(a.principal, { ...a, rx: a.x, rz: a.z, ryaw: a.yaw, moving: false });
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
      if (dist > 0.001) { s.rx += dx * k; s.rz += dz * k; changed = true; }
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
          <NpcFigure color="#5f86c8" seed={hashSeed(s.principal)} idle={!s.moving} />
          <NamePlate name={s.name} />
        </group>
      ))}
    </group>
  );
}

/** A name floating at head height, always facing the viewer. */
function NamePlate({ name }: { name: string }) {
  const ref = useRef<THREE.Sprite>(null);
  const texture = useRef<THREE.CanvasTexture | null>(null);

  if (!texture.current) {
    const c = document.createElement("canvas");
    c.width = 256; c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "rgba(10,14,20,0.72)";
    ctx.fillRect(0, 0, 256, 64);
    ctx.strokeStyle = "rgba(120,170,230,0.55)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, 254, 62);
    ctx.font = "600 30px 'Courier New', monospace";
    ctx.fillStyle = "#cfe2ff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name.slice(0, 16), 128, 34);
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

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 1000;
}
