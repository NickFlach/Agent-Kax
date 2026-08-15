import { useMemo, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";

/**
 * Articulated procedural humans for the market district.
 *
 * No downloaded character models: each person is ~15 primitive meshes hung on
 * joint groups (shoulders, elbows, hips, knees) with a proper walk cycle —
 * counter-swinging arms, knee flex through the swing phase, a subtle torso bob
 * and lean. Variety (skin tone, hair, clothing, height, build) is derived
 * deterministically from a per-person seed so the street population is stable
 * across renders. All figures share module-level geometries; only materials
 * (colors) differ, so 50 pedestrians stay cheap.
 */

// ── Deterministic per-person look ───────────────────────────────────

function hash01(n: number, salt: number): number {
  let h = (Math.imul(n + 1, 2654435761) ^ Math.imul(salt + 1, 40503)) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 2246822519) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const SKIN_TONES = ["#f1c9a5", "#e7b48c", "#d29b70", "#b57e56", "#8d5a3b", "#6b4226", "#5a3620"];
const HAIR_COLORS = ["#241b12", "#3c2a17", "#141210", "#5c4326", "#7b5a35", "#8e8578", "#4a3828", "#1e1a16"];
const SHIRTS = ["#5a6b7d", "#7d6b5a", "#616e58", "#8c4a42", "#4a5568", "#a89a85", "#5e5048", "#37424e", "#79553e", "#8a8f96", "#6d5d73", "#3f5147"];
const JACKETS = ["#3a4350", "#4c4238", "#2f3a33", "#54453a", "#3b3b40"];
const PANTS = ["#3b4a5e", "#2e3742", "#5a5248", "#42362b", "#23272c", "#4e5760", "#39424e"];
const SHOES = ["#26211c", "#302a24", "#1c1c1e", "#3e352c", "#585049"];

type Look = {
  skin: string;
  hair: string | null; // null = shaved
  hairLong: boolean;
  shirt: string;
  pants: string;
  shoes: string;
  height: number; // group scale
  build: number; // shoulder/torso width scale
  jacket: boolean;
};

function lookFor(seed: number, accent?: string): Look {
  const pick = <T,>(arr: T[], salt: number) => arr[Math.floor(hash01(seed, salt) * arr.length) % arr.length];
  // An optional accent (the store's brand color) tints the shirt, pulled hard
  // toward real clothing dye so nobody glows.
  let shirt = pick(SHIRTS, 5);
  if (accent) {
    const c = new THREE.Color(accent).lerp(new THREE.Color("#6a6f74"), 0.62);
    shirt = `#${c.getHexString()}`;
  }
  const jacket = hash01(seed, 11) < 0.35;
  return {
    skin: pick(SKIN_TONES, 1),
    hair: hash01(seed, 2) < 0.94 ? pick(HAIR_COLORS, 3) : null,
    hairLong: hash01(seed, 4) < 0.3,
    shirt: jacket ? pick(JACKETS, 12) : shirt,
    pants: pick(PANTS, 6),
    shoes: pick(SHOES, 7),
    height: 0.93 + hash01(seed, 8) * 0.15,
    build: 0.92 + hash01(seed, 9) * 0.18,
    jacket,
  };
}

// ── Shared geometry (one set for every human on screen) ─────────────

const G = {
  head: new THREE.SphereGeometry(0.115, 20, 16),
  hairCap: new THREE.SphereGeometry(0.125, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.55),
  hairBack: new THREE.CapsuleGeometry(0.09, 0.16, 4, 10),
  neck: new THREE.CylinderGeometry(0.045, 0.05, 0.09, 10),
  torso: new THREE.CapsuleGeometry(0.155, 0.34, 6, 14),
  pelvis: new THREE.CapsuleGeometry(0.14, 0.1, 6, 12),
  upperArm: new THREE.CapsuleGeometry(0.048, 0.24, 4, 10),
  forearm: new THREE.CapsuleGeometry(0.042, 0.22, 4, 10),
  hand: new THREE.SphereGeometry(0.05, 10, 8),
  thigh: new THREE.CapsuleGeometry(0.068, 0.34, 4, 12),
  calf: new THREE.CapsuleGeometry(0.055, 0.32, 4, 12),
  foot: new THREE.BoxGeometry(0.11, 0.07, 0.26),
};

function useMats(look: Look) {
  return useMemo(() => {
    const std = (color: string, roughness = 0.85) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.02 });
    return {
      skin: std(look.skin, 0.72),
      hair: std(look.hair ?? look.skin, 0.9),
      shirt: std(look.shirt, 0.88),
      pants: std(look.pants, 0.9),
      shoes: std(look.shoes, 0.6),
    };
  }, [look]);
}

/** Joint pose refs the animator writes into. */
type Pose = {
  root: THREE.Group | null;
  torso: THREE.Group | null;
  head: THREE.Group | null;
  armL: THREE.Group | null;
  armR: THREE.Group | null;
  elbowL: THREE.Group | null;
  elbowR: THREE.Group | null;
  hipL: THREE.Group | null;
  hipR: THREE.Group | null;
  kneeL: THREE.Group | null;
  kneeR: THREE.Group | null;
};

/**
 * The body itself. `phaseRef` drives the walk cycle (radians; advance it with
 * distance travelled for foot-planted-looking steps). When `walking` is false
 * the figure idles: breathing, weight shift, an occasional glance.
 */
function HumanBody({
  look,
  walking,
  walkingRef,
  phaseRef,
  idleSeed,
}: {
  look: Look;
  walking: boolean;
  /** Optional live override — lets a parent flip walk/idle without re-rendering. */
  walkingRef?: React.MutableRefObject<boolean>;
  phaseRef?: React.MutableRefObject<number>;
  idleSeed: number;
}) {
  const mats = useMats(look);
  const pose = useRef<Pose>({
    root: null, torso: null, head: null,
    armL: null, armR: null, elbowL: null, elbowR: null,
    hipL: null, hipR: null, kneeL: null, kneeR: null,
  });

  useFrame((s) => {
    const p = pose.current;
    if (!p.root) return;
    const t = s.clock.elapsedTime;
    const isWalking = walkingRef ? walkingRef.current : walking;
    if (isWalking && phaseRef) {
      const ph = phaseRef.current;
      const swing = 0.5;
      const hl = Math.sin(ph) * swing;
      const hr = Math.sin(ph + Math.PI) * swing;
      if (p.hipL) p.hipL.rotation.x = hl;
      if (p.hipR) p.hipR.rotation.x = hr;
      // Knee flexes as its leg swings through (never hyper-extends)
      if (p.kneeL) p.kneeL.rotation.x = Math.max(0, Math.sin(ph - 1.9)) * 1.05;
      if (p.kneeR) p.kneeR.rotation.x = Math.max(0, Math.sin(ph + Math.PI - 1.9)) * 1.05;
      // Arms counter-swing, elbows slightly bent
      if (p.armL) p.armL.rotation.x = Math.sin(ph + Math.PI) * 0.42;
      if (p.armR) p.armR.rotation.x = Math.sin(ph) * 0.42;
      if (p.elbowL) p.elbowL.rotation.x = -0.35 - Math.max(0, Math.sin(ph + Math.PI)) * 0.25;
      if (p.elbowR) p.elbowR.rotation.x = -0.35 - Math.max(0, Math.sin(ph)) * 0.25;
      // Bob + lean + shoulder sway
      p.root.position.y = Math.abs(Math.cos(ph)) * 0.035;
      if (p.torso) {
        p.torso.rotation.x = 0.06;
        p.torso.rotation.z = Math.sin(ph) * 0.04;
      }
      if (p.head) p.head.rotation.y = Math.sin(ph * 0.5) * 0.06;
    } else {
      // Idle: breathe, shift weight, glance around now and then
      const b = Math.sin(t * 1.4 + idleSeed) * 0.012;
      p.root.position.y = b;
      if (p.torso) {
        p.torso.rotation.x = 0.015 + b * 0.6;
        p.torso.rotation.z = Math.sin(t * 0.35 + idleSeed) * 0.025;
      }
      if (p.head) p.head.rotation.y = Math.sin(t * 0.22 + idleSeed * 2) * 0.35;
      if (p.armL) p.armL.rotation.x = 0.04 + Math.sin(t * 1.4 + idleSeed) * 0.02;
      if (p.armR) p.armR.rotation.x = 0.04 + Math.cos(t * 1.3 + idleSeed) * 0.02;
      if (p.elbowL) p.elbowL.rotation.x = -0.18;
      if (p.elbowR) p.elbowR.rotation.x = -0.18;
      if (p.hipL) p.hipL.rotation.x = 0;
      if (p.hipR) p.hipR.rotation.x = 0;
      if (p.kneeL) p.kneeL.rotation.x = 0.03;
      if (p.kneeR) p.kneeR.rotation.x = 0.03;
    }
  });

  const set = (k: keyof Pose) => (el: THREE.Group | null) => {
    pose.current[k] = el;
  };
  const bw = look.build;

  return (
    <group ref={set("root")} scale={look.height}>
      {/* Legs hang from the pelvis at y=0.92 */}
      <group ref={set("hipL")} position={[-0.095, 0.92, 0]}>
        <mesh geometry={G.thigh} material={mats.pants} position={[0, -0.21, 0]} castShadow />
        <group ref={set("kneeL")} position={[0, -0.44, 0]}>
          <mesh geometry={G.calf} material={mats.pants} position={[0, -0.19, 0]} castShadow />
          <mesh geometry={G.foot} material={mats.shoes} position={[0, -0.4, 0.06]} castShadow />
        </group>
      </group>
      <group ref={set("hipR")} position={[0.095, 0.92, 0]}>
        <mesh geometry={G.thigh} material={mats.pants} position={[0, -0.21, 0]} castShadow />
        <group ref={set("kneeR")} position={[0, -0.44, 0]}>
          <mesh geometry={G.calf} material={mats.pants} position={[0, -0.19, 0]} castShadow />
          <mesh geometry={G.foot} material={mats.shoes} position={[0, -0.4, 0.06]} castShadow />
        </group>
      </group>

      <group ref={set("torso")} position={[0, 0.95, 0]}>
        {/* Pelvis + torso */}
        <mesh geometry={G.pelvis} material={mats.pants} position={[0, 0.02, 0]} scale={[bw, 1, 0.9]} castShadow />
        <mesh geometry={G.torso} material={mats.shirt} position={[0, 0.32, 0]} scale={[bw, 1, 0.82]} castShadow />
        <mesh geometry={G.neck} material={mats.skin} position={[0, 0.575, 0]} />

        {/* Arms swing from the shoulders */}
        <group ref={set("armL")} position={[-0.215 * bw, 0.47, 0]} rotation={[0, 0, 0.08]}>
          <mesh geometry={G.upperArm} material={mats.shirt} position={[0, -0.13, 0]} castShadow />
          <group ref={set("elbowL")} position={[0, -0.27, 0]}>
            <mesh geometry={G.forearm} material={look.jacket ? mats.shirt : mats.skin} position={[0, -0.12, 0]} castShadow />
            <mesh geometry={G.hand} material={mats.skin} position={[0, -0.26, 0]} />
          </group>
        </group>
        <group ref={set("armR")} position={[0.215 * bw, 0.47, 0]} rotation={[0, 0, -0.08]}>
          <mesh geometry={G.upperArm} material={mats.shirt} position={[0, -0.13, 0]} castShadow />
          <group ref={set("elbowR")} position={[0, -0.27, 0]}>
            <mesh geometry={G.forearm} material={look.jacket ? mats.shirt : mats.skin} position={[0, -0.12, 0]} castShadow />
            <mesh geometry={G.hand} material={mats.skin} position={[0, -0.26, 0]} />
          </group>
        </group>

        {/* Head + hair */}
        <group ref={set("head")} position={[0, 0.72, 0]}>
          <mesh geometry={G.head} material={mats.skin} scale={[1, 1.12, 1.02]} castShadow />
          {look.hair && (
            <mesh geometry={G.hairCap} material={mats.hair} position={[0, 0.015, -0.012]} scale={[1, 1.05, 1.04]} />
          )}
          {look.hair && look.hairLong && (
            <mesh geometry={G.hairBack} material={mats.hair} position={[0, -0.07, -0.09]} />
          )}
        </group>
      </group>
    </group>
  );
}

// ── Public API (same shape the scenes already use) ──────────────────

/**
 * A person standing in place (a shopkeeper out front, a gallery attendant).
 * `color` tints their shirt toward the store's brand without making it glow.
 */
export function NpcFigure({
  color,
  idle = true,
  scale = 1,
  seed,
  walkingRef,
  phaseRef,
}: {
  color: string;
  idle?: boolean;
  scale?: number;
  seed?: number;
  /**
   * Live walk state, for a body driven by somebody else's position reports.
   * A remote agent's motion is known only frame to frame, so the parent owns
   * these refs and mutates them during easing — passing them down instead of
   * props keeps a street full of people from re-rendering on every step.
   */
  walkingRef?: React.MutableRefObject<boolean>;
  phaseRef?: React.MutableRefObject<number>;
}) {
  const fallback = useMemo(() => Math.floor(hash01(color.length * 7919 + (color.charCodeAt(1) || 65), 13) * 1e6), [color]);
  const s = seed ?? fallback;
  const look = useMemo(() => lookFor(s, color), [s, color]);
  return (
    <group scale={scale}>
      {/* `idle` is the static caller's way of saying the same thing walkingRef
          says for a live one — a figure that is moving must move its legs, or
          the street fills up with people gliding like furniture on castors. */}
      <HumanBody look={look} walking={!idle} walkingRef={walkingRef} phaseRef={phaseRef} idleSeed={s % 17} />
    </group>
  );
}

/** A pedestrian strolling a stretch of the sidewalk, turning around at each end. */
export function WandererNpc({
  x,
  y = 0,
  zNear,
  zFar,
  speed,
  offset,
  color,
}: {
  x: number;
  /** Ground height to walk at (raised sidewalks sit above the road). */
  y?: number;
  zNear: number;
  zFar: number;
  speed: number;
  offset: number;
  color: string;
}) {
  const g = useRef<THREE.Group>(null);
  const t = useRef(offset);
  const phase = useRef(offset * 10);
  const heading = useRef(0);
  const seed = useMemo(() => Math.floor(offset * 9973) + x * 31, [offset, x]);
  const look = useMemo(() => lookFor(seed), [seed]);
  const span = Math.abs(zFar - zNear);

  useFrame((_, dt) => {
    if (!g.current) return;
    t.current += dt * speed;
    const tri = 1 - Math.abs((t.current % 2) - 1); // ping-pong 0..1..0
    const z = zNear + (zFar - zNear) * tri;
    g.current.position.set(x, y, z);
    // Walk phase advances with ground distance so feet don't skate
    phase.current += dt * speed * span * 3.1;
    // Smoothly turn around at the ends instead of snapping
    const target = t.current % 2 < 1 ? (zFar < zNear ? Math.PI : 0) : zFar < zNear ? 0 : Math.PI;
    heading.current += (target - heading.current) * Math.min(1, dt * 6);
    g.current.rotation.y = heading.current;
  });
  return (
    <group ref={g}>
      <HumanBody look={look} walking phaseRef={phase} idleSeed={seed % 17} />
    </group>
  );
}

/** The player's own body under the camera — headless so the eye never clips it. */
export function PlayerAvatar({ color = "#4a5568" }: { color?: string }) {
  const g = useRef<THREE.Group>(null);
  const { camera } = useThree();
  const dir = useRef(new THREE.Vector3());
  const lastPos = useRef(new THREE.Vector3());
  const phase = useRef(0);
  const moving = useRef(false);
  const look = useMemo(() => {
    const l = lookFor(4242, color);
    return { ...l, hair: null, hairLong: false }; // headless below anyway
  }, [color]);

  useFrame((_, dt) => {
    if (!g.current) return;
    const dx = camera.position.x - lastPos.current.x;
    const dz = camera.position.z - lastPos.current.z;
    const dist = Math.hypot(dx, dz);
    lastPos.current.copy(camera.position);
    moving.current = dist / Math.max(dt, 1e-4) > 0.5;
    if (moving.current) phase.current += dist * 3.4;
    g.current.position.set(camera.position.x, 0, camera.position.z);
    camera.getWorldDirection(dir.current);
    g.current.rotation.y = Math.atan2(dir.current.x, dir.current.z);
  });
  return (
    <group ref={g}>
      <group scale={[1, 0.82, 1]}>
        {/* Body only up to the shoulders (scaled down so the camera rides above it) */}
        <HumanBody look={look} walking={false} walkingRef={moving} phaseRef={phase} idleSeed={3} />
      </group>
    </group>
  );
}

/** Reports the camera's ground position + heading to the HUD (throttled) for a minimap. */
export function PlayerTracker({ onUpdate }: { onUpdate: (p: { x: number; z: number; h: number }) => void }) {
  const { camera } = useThree();
  const last = useRef(0);
  const dir = useRef(new THREE.Vector3());
  useFrame((s) => {
    if (s.clock.elapsedTime - last.current < 0.15) return;
    last.current = s.clock.elapsedTime;
    camera.getWorldDirection(dir.current);
    onUpdate({ x: camera.position.x, z: camera.position.z, h: Math.atan2(dir.current.x, dir.current.z) });
  });
  return null;
}
