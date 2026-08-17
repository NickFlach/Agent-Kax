import { useState, useMemo, useRef, useCallback, Suspense, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Text, Sky } from "@react-three/drei";
import * as THREE from "three";
import { Link, useLocation } from "wouter";
import { useGetMarketplaceCombined } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { useStorefrontSeo } from "@/lib/storefront-seo";
import { FirstPersonRig, type FpsSpawn } from "@/components/first-person-rig";
import { Horizon } from "@/components/horizon";
import { BackAlley, SideStreet, FlaukowskiCafe, ALLEY_X } from "@/components/city-back-streets";
import { usePresence, RemoteAgents } from "@/components/presence";
import { isTypingTarget } from "@/lib/is-typing";
import { useDayPhase } from "@/lib/time-of-day";
import { NpcFigure, WandererNpc, PlayerTracker } from "@/components/npc";
import {
  asphaltTexture,
  sidewalkTexture,
  brickTexture,
  stuccoTexture,
  concreteTexture,
  upperWindowsTexture,
  awningTexture,
  barkTexture,
  glassTowerTexture,
  repeated,
} from "@/lib/city-textures";
import "./marketplace-3d.css";
import { DISPLAY_FONT } from "@/lib/fonts";
import { storefrontWindowCard } from "@/lib/storefront-window";
import { streetDepthFor, monumentZFor, venueFootprint, layoutFor, MAX_STREET_STOREFRONTS } from "@/lib/city-layout";
import { STREET_MOUTHS } from "@/lib/undercroft";
import { DirectoryBoard, useCityRooms, BOARD_FOOTPRINT } from "@/components/directory-board";


type SceneAgent = {
  slug: string;
  name: string;
  artifacts: number;
  drops: number;
  claimed: boolean;
  source: "obc" | "constellation";
  phi: number | null;
  consciousnessLevel: string | null;
};

function startClaim() {
  const base = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "");
  window.location.href = `${base}/login?returnTo=${encodeURIComponent("/agents")}`;
}

function detectWebGL(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const canvas = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (canvas.getContext("webgl") || canvas.getContext("experimental-webgl")));
  } catch {
    return false;
  }
}

/** Deterministic 0..1 hash of a string (FNV-1a) — stable per agent, no RNG. */
function hash01(s: string, salt = 0): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

// Real shop-awning canvas dyes and painted-sign boards — no neon.
const AWNING_COLORS = ["#2f5d46", "#7a2e33", "#2e4468", "#9c5b2a", "#28606b", "#6b3d63", "#845d2f"];
const SIGN_BOARDS = ["#1e2a25", "#2a1f1e", "#1d2432", "#252017", "#20262b"];
const FADED_AWNING = "#8f887c";

/**
 * One mixed-use building: a real storefront (display glass, door, painted
 * sign, striped awning) under brick/stucco upper floors with genuine-looking
 * windows. Height still scales with the store's catalog; claim status shows
 * the way it would on an actual street — lit interior and a fresh awning for
 * claimed stores, dark glass and a FOR LEASE card for available ones.
 */
function Storefront({
  agent,
  position,
  rotation,
  selected,
  onClick,
  onDoubleClick,
}: {
  agent: SceneAgent;
  position: [number, number, number];
  rotation: [number, number, number];
  selected: boolean;
  onClick: (a: SceneAgent) => void;
  onDoubleClick: (a: SceneAgent) => void;
}) {
  const isClaimed = agent.claimed;
  const isConstellation = agent.source === "constellation";
  const windowCard = storefrontWindowCard(agent);

  const seed = hash01(agent.slug || agent.name, 1);
  const seed2 = hash01(agent.slug || agent.name, 7);
  const seed3 = hash01(agent.slug || agent.name, 13);

  const bodyH = 3.4 + Math.min(4.6, Math.log10(1 + Math.max(0, agent.artifacts)) * 1.55);
  const bodyW = 2.6 + seed * 0.9;
  const groundH = 2.75; // storefront story height
  const upperH = Math.max(1.1, bodyH - groundH);
  const floors = Math.max(1, Math.min(5, Math.round(upperH / 1.15)));
  const cols = Math.max(2, Math.min(5, Math.round(bodyW / 0.85)));

  // Constellation nodes read as the street's modern infill: gray render finish.
  const wall: "brick" | "stucco" = isConstellation ? "stucco" : seed2 > 0.45 ? "brick" : "stucco";
  const wallVariant = isConstellation ? 3 : Math.floor(seed3 * 4);
  const litSeed = Math.floor(seed * 10);

  const awningColor = isConstellation ? null : isClaimed ? AWNING_COLORS[Math.floor(seed * AWNING_COLORS.length)] : FADED_AWNING;
  const signBoard = SIGN_BOARDS[Math.floor(seed2 * SIGN_BOARDS.length)];
  const roofType = Math.floor(seed2 * 3);

  const textures = useMemo(() => {
    const base = wall === "brick" ? brickTexture(wallVariant) : stuccoTexture(wallVariant);
    return {
      wallSide: repeated(base, Math.max(1, Math.round(bodyW / 1.4)), Math.max(1, Math.round(bodyH / 1.4))),
      wallFront: repeated(base, Math.max(1, Math.round(bodyW / 1.4)), 2),
      upper: upperWindowsTexture({ wall, variant: wallVariant, floors, cols, litSeed }),
      awning: awningColor ? awningTexture(awningColor) : null,
      concrete: concreteTexture(),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wall, wallVariant, floors, cols, litSeed, awningColor]);

  const initials = (agent.name || agent.slug).substring(0, 2).toUpperCase();
  const top = bodyH;

  // `delta` guard: a look-drag that happens to end on a building is not a click.
  const select = (e: { stopPropagation?: () => void; delta?: number }) => {
    if ((e.delta ?? 0) > 5) return;
    e.stopPropagation?.();
    onClick(agent);
  };
  const enter = (e: { stopPropagation?: () => void; delta?: number }) => {
    if ((e.delta ?? 0) > 5) return;
    e.stopPropagation?.();
    onDoubleClick(agent);
  };

  return (
    <group
      position={position}
      rotation={rotation}
      onClick={select}
      onDoubleClick={enter}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "auto")}
    >
      {/* Invisible hit box covering the whole (variable-height) building */}
      <mesh position={[0, (top + 1) / 2, 0.3]} visible={false}>
        <boxGeometry args={[bodyW + 0.6, top + 2.5, 3.6]} />
        <meshBasicMaterial />
      </mesh>

      {/* Ground story — masonry shell */}
      <mesh position={[0, groundH / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[bodyW, groundH, 3]} />
        <meshStandardMaterial map={textures.wallSide} roughness={0.92} metalness={0.02} />
      </mesh>

      {/* Storefront: recessed dark reveal, then glass + interior */}
      <mesh position={[0, 1.18, 1.505]}>
        <planeGeometry args={[bodyW - 0.5, 2.1]} />
        <meshStandardMaterial color="#241f1a" roughness={0.8} />
      </mesh>
      {/* Interior glow (claimed) or dark vacancy (available) behind the glass */}
      <mesh position={[0, 1.18, 1.47]}>
        <planeGeometry args={[bodyW - 0.6, 1.95]} />
        {isClaimed || isConstellation ? (
          <meshStandardMaterial color="#f7dfae" emissive="#e8b96a" emissiveIntensity={0.75} roughness={1} />
        ) : (
          <meshStandardMaterial color="#161514" roughness={1} />
        )}
      </mesh>
      {/* Display glass */}
      <mesh position={[-0.28, 1.18, 1.52]}>
        <planeGeometry args={[bodyW - 1.5, 1.9]} />
        <meshPhysicalMaterial color="#9fb4bd" transparent opacity={0.28} roughness={0.08} metalness={0.1} />
      </mesh>
      {/* Window mullions */}
      <mesh position={[-0.28, 1.18, 1.53]}>
        <boxGeometry args={[0.05, 1.9, 0.03]} />
        <meshStandardMaterial color="#33302b" roughness={0.5} metalness={0.4} />
      </mesh>
      <mesh position={[-0.28, 1.18, 1.53]} rotation={[0, 0, Math.PI / 2]}>
        <boxGeometry args={[0.05, bodyW - 1.5, 0.03]} />
        <meshStandardMaterial color="#33302b" roughness={0.5} metalness={0.4} />
      </mesh>
      {/* The card in an available store's window.

          FOR LEASE used to appear whenever `!claimed`, but `claimed` means
          "has a non-system owner" — not "empty". Live, every one of the 278
          unclaimed storefronts holds work, so the street was advertising
          bodies of work as vacant premises, `rex` and its 1534 artifacts
          among them (#302). Both cards still say the store can be claimed;
          only one of them claims there is nothing inside. */}
      {windowCard === "for-lease" && (
        <group position={[-0.28, 1.45, 1.54]}>
          <mesh>
            <planeGeometry args={[0.72, 0.46]} />
            <meshStandardMaterial color="#f4efe4" roughness={0.9} />
          </mesh>
          <Suspense fallback={null}>
            <Text position={[0, 0.07, 0.01]} fontSize={0.13} color="#8c2f2a" font={DISPLAY_FONT} anchorX="center" anchorY="middle">
              FOR LEASE
            </Text>
            <Text position={[0, -0.11, 0.01]} fontSize={0.06} color="#4a4640" font={DISPLAY_FONT} anchorX="center" anchorY="middle">
              inquire at kax
            </Text>
          </Suspense>
        </group>
      )}
      {windowCard === "unclaimed-with-works" && (
        <group position={[-0.28, 1.45, 1.54]}>
          <mesh>
            <planeGeometry args={[0.72, 0.46]} />
            <meshStandardMaterial color="#efeadc" roughness={0.9} />
          </mesh>
          <Suspense fallback={null}>
            <Text position={[0, 0.11, 0.01]} fontSize={0.075} color="#6a6252" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.12}>
              UNCLAIMED
            </Text>
            <Text position={[0, -0.02, 0.01]} fontSize={0.055} color="#3f3a33" font={DISPLAY_FONT} anchorX="center" anchorY="middle" maxWidth={0.66} textAlign="center">
              {`works by ${agent.name}`}
            </Text>
            <Text position={[0, -0.15, 0.01]} fontSize={0.05} color="#8a8272" font={DISPLAY_FONT} anchorX="center" anchorY="middle">
              {`${agent.artifacts} pieces · inquire at kax`}
            </Text>
          </Suspense>
        </group>
      )}
      {/* Door (right side of the front) with frame, kick plate and handle */}
      <mesh position={[bodyW / 2 - 0.62, 1.05, 1.52]}>
        <boxGeometry args={[0.86, 2.1, 0.06]} />
        <meshStandardMaterial color="#2e2a26" roughness={0.6} />
      </mesh>
      <mesh position={[bodyW / 2 - 0.62, 1.05, 1.55]}>
        <boxGeometry args={[0.68, 1.94, 0.03]} />
        <meshStandardMaterial color={isConstellation ? "#4c565e" : "#5d4630"} roughness={0.55} metalness={0.15} />
      </mesh>
      <mesh position={[bodyW / 2 - 0.62, 1.7, 1.57]}>
        <planeGeometry args={[0.5, 0.5]} />
        <meshPhysicalMaterial color="#aebfc7" transparent opacity={0.35} roughness={0.1} />
      </mesh>
      <mesh position={[bodyW / 2 - 0.36, 1.0, 1.58]}>
        <cylinderGeometry args={[0.016, 0.016, 0.28, 8]} />
        <meshStandardMaterial color="#b8a988" metalness={0.85} roughness={0.3} />
      </mesh>

      {/* Stone threshold */}
      <mesh position={[0, 0.05, 1.65]} receiveShadow>
        <boxGeometry args={[bodyW + 0.2, 0.1, 0.5]} />
        <meshStandardMaterial map={textures.concrete} roughness={0.95} />
      </mesh>

      {/* Awning (shops) or a slim steel canopy (constellation nodes) */}
      {textures.awning ? (
        <group position={[-0.28, 2.42, 1.62]}>
          <mesh rotation={[Math.PI / 4.2, 0, 0]} castShadow>
            <boxGeometry args={[bodyW - 1.2, 0.9, 0.045]} />
            <meshStandardMaterial map={textures.awning} roughness={0.95} side={THREE.DoubleSide} />
          </mesh>
          {/* Scalloped valance edge */}
          <mesh position={[0, -0.33, 0.31]}>
            <boxGeometry args={[bodyW - 1.2, 0.16, 0.045]} />
            <meshStandardMaterial map={textures.awning} roughness={0.95} />
          </mesh>
        </group>
      ) : (
        <mesh position={[0, 2.48, 1.85]} castShadow>
          <boxGeometry args={[bodyW - 0.4, 0.08, 0.8]} />
          <meshStandardMaterial color="#5a6167" metalness={0.7} roughness={0.35} />
        </mesh>
      )}

      {/* Painted sign board over the storefront */}
      <mesh position={[0, 3.02, 1.54]} castShadow>
        <boxGeometry args={[bodyW - 0.15, 0.62, 0.09]} />
        <meshStandardMaterial color={signBoard} roughness={0.7} emissive={selected ? "#c8a45c" : "#000000"} emissiveIntensity={selected ? 0.22 : 0} />
      </mesh>
      {/* Thin brass trim that warms up when the store is selected */}
      <mesh position={[0, 3.02, 1.585]}>
        <boxGeometry args={[bodyW - 0.1, 0.66, 0.012]} />
        <meshStandardMaterial
          color="#b39355"
          metalness={0.8}
          roughness={0.35}
          transparent
          opacity={selected ? 0.95 : 0.25}
          emissive="#c8a45c"
          emissiveIntensity={selected ? 0.5 : 0}
        />
      </mesh>

      {/* Upper floors with a real window grid on the street face */}
      <mesh position={[0, groundH + upperH / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[bodyW, upperH, 3]} />
        <meshStandardMaterial attach="material-0" map={textures.wallSide} roughness={0.92} />
        <meshStandardMaterial attach="material-1" map={textures.wallSide} roughness={0.92} />
        <meshStandardMaterial attach="material-2" map={textures.wallFront} roughness={0.92} />
        <meshStandardMaterial attach="material-3" map={textures.wallFront} roughness={0.92} />
        <meshStandardMaterial attach="material-4" map={textures.upper} roughness={0.85} />
        <meshStandardMaterial attach="material-5" map={textures.wallFront} roughness={0.92} />
      </mesh>

      {/* Cornice + roofline */}
      <mesh position={[0, top + 0.09, 0.05]} castShadow>
        <boxGeometry args={[bodyW + 0.3, 0.18, 3.25]} />
        <meshStandardMaterial map={textures.concrete} roughness={0.9} />
      </mesh>
      {roofType === 1 ? (
        <mesh position={[0, top + 0.62, 0]} castShadow>
          <boxGeometry args={[bodyW * 0.55, 0.85, 2.2]} />
          <meshStandardMaterial color="#57504a" roughness={0.9} />
        </mesh>
      ) : roofType === 2 ? (
        <group position={[bodyW * 0.18, top + 0.18, -0.4]}>
          {/* Rooftop water tank */}
          <mesh position={[0, 0.55, 0]} castShadow>
            <cylinderGeometry args={[0.42, 0.46, 1.0, 12]} />
            <meshStandardMaterial color="#5c4a38" roughness={0.95} />
          </mesh>
          <mesh position={[0, 1.18, 0]} castShadow>
            <coneGeometry args={[0.5, 0.35, 12]} />
            <meshStandardMaterial color="#4a3c2e" roughness={0.95} />
          </mesh>
        </group>
      ) : (
        <mesh position={[-bodyW * 0.2, top + 0.42, -0.5]} castShadow>
          {/* HVAC unit */}
          <boxGeometry args={[0.9, 0.5, 0.7]} />
          <meshStandardMaterial color="#8d9299" metalness={0.5} roughness={0.55} />
        </mesh>
      )}

      {/* Hanging blade sign on a bracket */}
      <group position={[bodyW / 2 + 0.02, 2.62, 1.2]}>
        <mesh position={[0.18, 0.32, 0]}>
          <boxGeometry args={[0.5, 0.04, 0.04]} />
          <meshStandardMaterial color="#2b2b2e" metalness={0.7} roughness={0.4} />
        </mesh>
        <mesh position={[0.34, -0.12, 0]} castShadow>
          <boxGeometry args={[0.04, 0.85, 0.6]} />
          <meshStandardMaterial color={signBoard} roughness={0.7} />
        </mesh>
        <Suspense fallback={null}>
          <Text position={[0.37, -0.12, 0]} rotation={[0, Math.PI / 2, 0]} fontSize={0.26} color="#e9dfc8" font={DISPLAY_FONT} anchorX="center" anchorY="middle">
            {initials}
          </Text>
        </Suspense>
      </group>

      {/* Sign lettering + a small brass plaque for constellation nodes */}
      <Suspense fallback={null}>
        <Text position={[0, 3.06, 1.6]} fontSize={0.27} color="#efe6d2" font={DISPLAY_FONT} anchorX="center" anchorY="middle" maxWidth={bodyW - 0.4}>
          {agent.name}
        </Text>
        <Text position={[0, 2.8, 1.6]} fontSize={0.11} color="#b9ac90" font={DISPLAY_FONT} anchorX="center" anchorY="middle">
          {isConstellation
            ? `constellation · Φ ${agent.phi != null ? agent.phi.toFixed(3) : "—"}`
            : `${agent.artifacts} work${agent.artifacts === 1 ? "" : "s"}`}
        </Text>
      </Suspense>

      {/* The shopkeeper out front */}
      <group position={[0.9, 0, 2.5]} rotation={[0, seed3 * 1.6 - 0.8, 0]}>
        <NpcFigure color={awningColor ?? "#4a5568"} seed={Math.floor(seed * 1e6)} />
      </group>
    </group>
  );
}

/** Reports the nearest store as you walk past it, so the HUD can offer
 *  "press E to enter". Only fires onNearest when the nearest store changes. */
function ProximityDetector({
  points,
  onNearest,
}: {
  points: Array<{ agent: SceneAgent; pos: [number, number, number] }>;
  onNearest: (a: SceneAgent | null) => void;
}) {
  const { camera } = useThree();
  const last = useRef<string | null>(null);
  useFrame(() => {
    let best: SceneAgent | null = null;
    let bestD = 8 * 8; // enter-radius²
    for (const p of points) {
      const dx = camera.position.x - p.pos[0];
      const dz = camera.position.z - p.pos[2];
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = p.agent;
      }
    }
    const key = best?.slug ?? null;
    if (key !== last.current) {
      last.current = key;
      onNearest(best);
    }
  });
  return null;
}

/** A classic park-style lamppost. Dead metal in daylight; after dusk the head
 *  lights and casts a real pool on the pavement. `lit` comes from the clock,
 *  not from a switch — see lib/time-of-day. */
function StreetLamp({ position, lit }: { position: [number, number, number]; lit: boolean }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.09, 0]} castShadow>
        <cylinderGeometry args={[0.14, 0.18, 0.18, 10]} />
        <meshStandardMaterial color="#26292c" metalness={0.6} roughness={0.5} />
      </mesh>
      <mesh position={[0, 1.7, 0]} castShadow>
        <cylinderGeometry args={[0.045, 0.07, 3.3, 8]} />
        <meshStandardMaterial color="#2c3033" metalness={0.65} roughness={0.45} />
      </mesh>
      <mesh position={[0, 3.42, 0]}>
        <cylinderGeometry args={[0.02, 0.13, 0.16, 8]} />
        <meshStandardMaterial color="#26292c" metalness={0.6} roughness={0.5} />
      </mesh>
      <mesh position={[0, 3.58, 0]}>
        <cylinderGeometry args={[0.11, 0.15, 0.24, 8]} />
        <meshPhysicalMaterial
          color="#f4ead0"
          transparent
          opacity={lit ? 0.95 : 0.75}
          roughness={0.4}
          emissive="#ffdf9e"
          emissiveIntensity={lit ? 2.4 : 0.12}
        />
      </mesh>
      {lit && (
        <pointLight position={[0, 3.5, 0]} intensity={26} distance={12} decay={2} color="#ffd79a" />
      )}
      <mesh position={[0, 3.74, 0]}>
        <coneGeometry args={[0.17, 0.14, 8]} />
        <meshStandardMaterial color="#26292c" metalness={0.6} roughness={0.5} />
      </mesh>
    </group>
  );
}

/** A street tree in a concrete planter — trunk, asymmetric canopy blobs.
 *  Texture helpers are module-cached, so calling them in render is free. */
function StreetTree({ position, seed }: { position: [number, number, number]; seed: number }) {
  const bark = barkTexture();
  const s = 0.9 + hash01(String(seed), 3) * 0.35;
  const lean = (hash01(String(seed), 5) - 0.5) * 0.12;
  const greens = ["#3d5a34", "#48653b", "#35502e", "#527247"];
  const g1 = greens[seed % greens.length];
  const g2 = greens[(seed + 1) % greens.length];
  return (
    <group position={position} scale={s} rotation={[0, seed, lean]}>
      {/* Planter */}
      <mesh position={[0, 0.22, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.05, 0.44, 1.05]} />
        <meshStandardMaterial map={concreteTexture()} roughness={0.95} />
      </mesh>
      <mesh position={[0, 0.4, 0]}>
        <boxGeometry args={[0.9, 0.1, 0.9]} />
        <meshStandardMaterial color="#3a2e22" roughness={1} />
      </mesh>
      {/* Trunk + limbs */}
      <mesh position={[0, 1.25, 0]} castShadow>
        <cylinderGeometry args={[0.07, 0.12, 1.8, 8]} />
        <meshStandardMaterial map={bark} roughness={0.95} />
      </mesh>
      <mesh position={[0.22, 1.9, 0.06]} rotation={[0, 0, -0.6]}>
        <cylinderGeometry args={[0.03, 0.05, 0.7, 6]} />
        <meshStandardMaterial map={bark} roughness={0.95} />
      </mesh>
      {/* Canopy — overlapping flattened, flat-shaded blobs read as leaf mass
          rather than smooth "lollipop" spheres */}
      <mesh position={[0, 2.65, 0]} scale={[1.15, 0.8, 1.1]} castShadow>
        <sphereGeometry args={[0.95, 7, 6]} />
        <meshStandardMaterial color={g1} roughness={1} flatShading />
      </mesh>
      <mesh position={[0.58, 2.4, 0.2]} scale={[1, 0.75, 1]} castShadow>
        <sphereGeometry args={[0.62, 6, 5]} />
        <meshStandardMaterial color={g2} roughness={1} flatShading />
      </mesh>
      <mesh position={[-0.55, 2.35, -0.15]} scale={[1, 0.72, 1]} castShadow>
        <sphereGeometry args={[0.58, 6, 5]} />
        <meshStandardMaterial color={g2} roughness={1} flatShading />
      </mesh>
      <mesh position={[-0.15, 3.1, 0.25]} scale={[1, 0.7, 1]} castShadow>
        <sphereGeometry args={[0.55, 6, 5]} />
        <meshStandardMaterial color="#2f4728" roughness={1} flatShading />
      </mesh>
      <mesh position={[0.2, 3.2, -0.2]} scale={[1, 0.75, 1]} castShadow>
        <sphereGeometry args={[0.5, 6, 5]} />
        <meshStandardMaterial color={g1} roughness={1} flatShading />
      </mesh>
    </group>
  );
}

/** Wood-and-iron sidewalk bench. */
function Bench({ position, rotation = 0 }: { position: [number, number, number]; rotation?: number }) {
  const slat = "#7a5c3d";
  const iron = "#2b2b2e";
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {[-0.62, 0.62].map((x) => (
        <group key={x} position={[x, 0, 0]}>
          <mesh position={[0, 0.22, 0]} castShadow>
            <boxGeometry args={[0.06, 0.44, 0.5]} />
            <meshStandardMaterial color={iron} metalness={0.6} roughness={0.45} />
          </mesh>
          <mesh position={[0, 0.62, -0.22]} rotation={[0.18, 0, 0]}>
            <boxGeometry args={[0.06, 0.5, 0.05]} />
            <meshStandardMaterial color={iron} metalness={0.6} roughness={0.45} />
          </mesh>
        </group>
      ))}
      {[0, 0.09, 0.18].map((z) => (
        <mesh key={z} position={[0, 0.45, 0.12 - z]} castShadow>
          <boxGeometry args={[1.5, 0.045, 0.085]} />
          <meshStandardMaterial color={slat} roughness={0.85} />
        </mesh>
      ))}
      {[0.62, 0.78].map((y) => (
        <mesh key={y} position={[0, y, -0.26]} rotation={[0.18, 0, 0]} castShadow>
          <boxGeometry args={[1.5, 0.075, 0.045]} />
          <meshStandardMaterial color={slat} roughness={0.85} />
        </mesh>
      ))}
    </group>
  );
}

/** Street furniture + the KAX monument closing the vista + skyline backdrop. */
function CityProps({ storeCount, lit }: { storeCount: number; lit: boolean }) {
  const rows = Math.max(1, Math.ceil(storeCount / 2));
  const depth = streetDepthFor(storeCount);
  const concrete = concreteTexture();

  const lamps: Array<[number, number, number]> = [];
  const trees: Array<[number, number, number]> = [];
  const benches: Array<[number, number, number]> = [];
  let i = 0;
  for (let z = -4; z > depth; z -= 9) {
    lamps.push([-2.95, 0.12, z]);
    lamps.push([2.95, 0.12, z + 4.5]);
    if (i % 2 === 0) {
      trees.push([2.95, 0.12, z]);
      trees.push([-2.95, 0.12, z + 4.5]);
    } else {
      benches.push([-2.98, 0.12, z + 2.2]);
      benches.push([2.98, 0.12, z - 2.2]);
    }
    i++;
  }

  // Skyline: quiet mid-rise blocks behind both storefront rows so the street
  // sits inside a city instead of a void.
  const skyline = useMemo(() => {
    const blocks: Array<{ pos: [number, number, number]; w: number; h: number; d: number; v: number; f: number; c: number }> = [];
    for (let side = 0; side < 2; side++) {
      const x = side === 0 ? -25 : 25;
      for (let k = 0; k < Math.max(3, Math.ceil(rows / 2)); k++) {
        const z = 2 - k * 11 - (side === 0 ? 0 : 5);
        if (z < depth - 14) break;
        const h = 9 + ((k * 37 + side * 13) % 8);
        blocks.push({
          pos: [x + ((k % 3) - 1) * 1.4, h / 2, z],
          w: 7.5,
          h,
          d: 8,
          v: (k + side) % 4,
          // Window grid at true city scale: ~1.35 units per story.
          f: Math.round(h / 1.35),
          c: 6,
        });
      }
    }
    return blocks;
  }, [rows, depth]);

  return (
    <group>
      {lamps.map((p, idx) => (
        <StreetLamp key={`l${idx}`} position={p} lit={lit} />
      ))}
      {trees.map((p, idx) => (
        <StreetTree key={`t${idx}`} position={p} seed={idx + 3} />
      ))}
      {benches.map((p, idx) => (
        <Bench key={`b${idx}`} position={p} rotation={p[0] < 0 ? Math.PI / 2 : -Math.PI / 2} />
      ))}

      {/* Trash cans near the benches */}
      {benches.map((p, idx) => (
        <group key={`tc${idx}`} position={[p[0], 0.12, p[2] + 1.1]}>
          <mesh position={[0, 0.32, 0]} castShadow>
            <cylinderGeometry args={[0.2, 0.17, 0.64, 12]} />
            <meshStandardMaterial color="#3a4a3c" metalness={0.4} roughness={0.6} />
          </mesh>
          <mesh position={[0, 0.66, 0]}>
            <cylinderGeometry args={[0.22, 0.2, 0.06, 12]} />
            <meshStandardMaterial color="#2c3830" metalness={0.4} roughness={0.6} />
          </mesh>
        </group>
      ))}

      {/* KAX monument closing the vista — carved stone, planted base */}
      <group position={[0, 0, monumentZFor(storeCount)]}>
        <mesh position={[0, 0.25, 0]} receiveShadow castShadow>
          <cylinderGeometry args={[2.2, 2.4, 0.5, 24]} />
          <meshStandardMaterial map={concrete} roughness={0.95} />
        </mesh>
        <mesh position={[0, 3.6, 0]} castShadow>
          <boxGeometry args={[1.5, 6.4, 1.5]} />
          <meshStandardMaterial map={concrete} roughness={0.9} />
        </mesh>
        <mesh position={[0, 7.15, 0]} castShadow>
          <boxGeometry args={[1.1, 0.9, 1.1]} />
          <meshStandardMaterial map={concrete} roughness={0.9} />
        </mesh>
        <Suspense fallback={null}>
          <Text position={[0, 4.6, 0.78]} fontSize={0.72} color="#3f3a33" font={DISPLAY_FONT} anchorX="center" anchorY="middle">
            KAX
          </Text>
          <Text position={[0, 3.7, 0.78]} fontSize={0.16} color="#5a544b" font={DISPLAY_FONT} anchorX="center" anchorY="middle" maxWidth={1.3} textAlign="center">
            MARKET DISTRICT
          </Text>
        </Suspense>
        {[0, 1, 2, 3].map((q) => (
          <StreetTree key={q} position={[Math.cos((q * Math.PI) / 2) * 3.4, 0, Math.sin((q * Math.PI) / 2) * 3.4]} seed={q + 11} />
        ))}
      </group>

      {/* Skyline backdrop (texture helpers are module-cached — direct calls) */}
      {skyline.map((b, idx) => {
        const wallKind: "brick" | "stucco" = idx % 2 ? "brick" : "stucco";
        const sideTex = idx % 2 ? brickTexture(b.v) : stuccoTexture(b.v);
        return (
          <mesh key={`s${idx}`} position={b.pos}>
            <boxGeometry args={[b.w, b.h, b.d]} />
            <meshStandardMaterial attach="material-0" map={upperWindowsTexture({ wall: wallKind, variant: b.v, floors: b.f, cols: b.c, litSeed: idx })} roughness={0.9} />
            <meshStandardMaterial attach="material-1" map={sideTex} roughness={0.9} />
            <meshStandardMaterial attach="material-2" color="#6f6a62" roughness={0.95} />
            <meshStandardMaterial attach="material-3" color="#6f6a62" roughness={0.95} />
            <meshStandardMaterial attach="material-4" map={upperWindowsTexture({ wall: wallKind, variant: b.v, floors: b.f, cols: b.c, litSeed: idx + 5 })} roughness={0.9} />
            <meshStandardMaterial attach="material-5" map={sideTex} roughness={0.9} />
          </mesh>
        );
      })}
    </group>
  );
}

/**
 * The Ghost Signals Prediction Market tower — the skyscraper closing the
 * skyline past the monument. Mirror-glass curtain wall with trading floors
 * burning after hours, a lit crown, street-level lobby, and a live-market
 * ticker band. Click (or walk up and press E) to enter the trading floor.
 */
function GhostSignalsTower({ position, onEnter }: { position: [number, number, number]; onEnter: () => void }) {
  const glass = glassTowerTexture(3);
  const glass2 = glassTowerTexture(7);
  const concrete = concreteTexture();
  const W = 15;
  const D = 15;
  const H = 46;
  const click = (e: { stopPropagation?: () => void; delta?: number }) => {
    if ((e.delta ?? 0) > 5) return;
    e.stopPropagation?.();
    onEnter();
  };
  return (
    <group
      position={position}
      onClick={click}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "auto")}
    >
      {/* Plaza plinth */}
      <mesh position={[0, 0.25, 0]} receiveShadow>
        <boxGeometry args={[W + 8, 0.5, D + 8]} />
        <meshStandardMaterial map={concrete} roughness={0.95} />
      </mesh>
      {/* Main shaft */}
      <mesh position={[0, H / 2 + 0.5, 0]} castShadow>
        <boxGeometry args={[W, H, D]} />
        <meshStandardMaterial attach="material-0" map={glass} roughness={0.25} metalness={0.55} />
        <meshStandardMaterial attach="material-1" map={glass2} roughness={0.25} metalness={0.55} />
        <meshStandardMaterial attach="material-2" color="#1a2530" roughness={0.7} />
        <meshStandardMaterial attach="material-3" color="#1a2530" roughness={0.7} />
        <meshStandardMaterial attach="material-4" map={glass} roughness={0.25} metalness={0.55} />
        <meshStandardMaterial attach="material-5" map={glass2} roughness={0.25} metalness={0.55} />
      </mesh>
      {/* Setback + crown */}
      <mesh position={[0, H + 2.2, 0]} castShadow>
        <boxGeometry args={[W * 0.62, 4, D * 0.62]} />
        <meshStandardMaterial map={glass2} roughness={0.3} metalness={0.5} />
      </mesh>
      <mesh position={[0, H + 4.7, 0]}>
        <boxGeometry args={[W * 0.64, 0.5, D * 0.64]} />
        <meshStandardMaterial color="#e8b96a" emissive="#e8b96a" emissiveIntensity={1.4} toneMapped={false} />
      </mesh>
      <mesh position={[0, H + 7.5, 0]}>
        <cylinderGeometry args={[0.06, 0.06, 5.5, 6]} />
        <meshStandardMaterial color="#2b2b2e" metalness={0.7} roughness={0.4} />
      </mesh>
      <mesh position={[0, H + 10.3, 0]}>
        <sphereGeometry args={[0.22, 10, 10]} />
        <meshStandardMaterial color="#ff5a5a" emissive="#ff5a5a" emissiveIntensity={2} toneMapped={false} />
      </mesh>

      {/* Street-level lobby: dark granite base, glowing entry */}
      <mesh position={[0, 2.5, D / 2 + 0.06]}>
        <planeGeometry args={[W - 1, 5]} />
        <meshStandardMaterial color="#10151b" roughness={0.5} metalness={0.3} />
      </mesh>
      <mesh position={[0, 2.1, D / 2 + 0.1]}>
        <planeGeometry args={[5.4, 4.2]} />
        <meshStandardMaterial color="#ffedc2" emissive="#e8c06a" emissiveIntensity={0.9} />
      </mesh>
      {[-2.9, 2.9].map((x) => (
        <mesh key={x} position={[x, 2.4, D / 2 + 0.35]} castShadow>
          <boxGeometry args={[0.5, 4.8, 0.5]} />
          <meshStandardMaterial color="#23282e" metalness={0.6} roughness={0.4} />
        </mesh>
      ))}

      {/* Live-market ticker band wrapping the facade above the lobby */}
      <mesh position={[0, 6.1, D / 2 + 0.12]}>
        <planeGeometry args={[W - 0.8, 0.85]} />
        <meshStandardMaterial color="#0a0d10" emissive="#173021" emissiveIntensity={0.8} />
      </mesh>
      <Suspense fallback={null}>
        <Text position={[0, 6.1, D / 2 + 0.16]} fontSize={0.4} color="#63e58b" font={DISPLAY_FONT} anchorX="center" anchorY="middle" maxWidth={W - 1}>
          {"YES 50.0 ▲ · GHOST SIGNALS · 35 OPEN MARKETS · BRIER-SCORED"}
        </Text>
        {/* Nameplate */}
        <Text position={[0, 9.4, D / 2 + 0.15]} fontSize={1.15} color="#e9dfc8" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.12}>
          GHOST SIGNALS
        </Text>
        <Text position={[0, 8.2, D / 2 + 0.15]} fontSize={0.44} color="#b9ac90" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.3}>
          PREDICTION MARKET
        </Text>
      </Suspense>
      <pointLight position={[0, 3, D / 2 + 3]} intensity={26} distance={16} color="#ffe2ae" />
    </group>
  );
}

/**
 * THE ARCADE — a classic two-story video arcade on the monument plaza:
 * black facade, giant chase-light marquee, glowing poster cases, light
 * spilling through the doors. Click / walk up + E to step inside (/arcade).
 */
function ArcadeVenue({ position, rotation, onEnter }: { position: [number, number, number]; rotation: number; onEnter: () => void }) {
  const click = (e: { stopPropagation?: () => void; delta?: number }) => {
    if ((e.delta ?? 0) > 5) return;
    e.stopPropagation?.();
    onEnter();
  };
  const chase = ["#ff2fb0", "#28e0ff", "#ffe94a"];
  return (
    <group
      position={position}
      rotation={[0, rotation, 0]}
      onClick={click}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "auto")}
    >
      {/* Shell */}
      <mesh position={[0, 3.75, 0]} castShadow receiveShadow>
        <boxGeometry args={[10, 7.5, 9]} />
        <meshStandardMaterial color="#181a1e" roughness={0.75} />
      </mesh>
      {/* Marquee band */}
      <mesh position={[0, 5.4, 4.56]} castShadow>
        <boxGeometry args={[9.6, 1.7, 0.25]} />
        <meshStandardMaterial color="#0b0b0d" roughness={0.5} />
      </mesh>
      <Suspense fallback={null}>
        <Text position={[0, 5.4, 4.72]} fontSize={1.05} color="#ff2fb0" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.3}>
          ARCADE
        </Text>
      </Suspense>
      {/* Chase lights framing the marquee */}
      {Array.from({ length: 12 }).map((_, i) => (
        <mesh key={`t${i}`} position={[-5 + i * 0.91, 6.35, 4.7]}>
          <sphereGeometry args={[0.07, 8, 8]} />
          <meshStandardMaterial color={chase[i % 3]} emissive={chase[i % 3]} emissiveIntensity={1.6} toneMapped={false} />
        </mesh>
      ))}
      {Array.from({ length: 12 }).map((_, i) => (
        <mesh key={`b${i}`} position={[-5 + i * 0.91, 4.45, 4.7]}>
          <sphereGeometry args={[0.07, 8, 8]} />
          <meshStandardMaterial color={chase[(i + 1) % 3]} emissive={chase[(i + 1) % 3]} emissiveIntensity={1.6} toneMapped={false} />
        </mesh>
      ))}
      {/* Entrance: glass doors with light spilling out */}
      <mesh position={[0, 1.7, 4.52]}>
        <planeGeometry args={[3.4, 3.4]} />
        <meshStandardMaterial color="#2a1636" emissive="#b12fff" emissiveIntensity={0.5} />
      </mesh>
      <mesh position={[0, 1.6, 4.56]}>
        <planeGeometry args={[3.0, 3.1]} />
        <meshPhysicalMaterial color="#c9b6ff" transparent opacity={0.3} roughness={0.1} />
      </mesh>
      <mesh position={[0, 1.6, 4.58]}>
        <boxGeometry args={[0.06, 3.1, 0.03]} />
        <meshStandardMaterial color="#0b0b0d" />
      </mesh>
      {/* Poster cases */}
      {[-3.4, 3.4].map((x, i) => (
        <group key={x} position={[x, 2.1, 4.54]}>
          <mesh castShadow>
            <boxGeometry args={[1.7, 2.4, 0.1]} />
            <meshStandardMaterial color="#0b0b0d" roughness={0.5} />
          </mesh>
          <mesh position={[0, 0, 0.06]}>
            <planeGeometry args={[1.45, 2.15]} />
            <meshStandardMaterial color={i ? "#1d3a5f" : "#3d1f4e"} emissive={i ? "#28e0ff" : "#ff2fb0"} emissiveIntensity={0.35} />
          </mesh>
          <Suspense fallback={null}>
            <Text position={[0, 0, 0.13]} fontSize={0.22} color="#f5f0e6" font={DISPLAY_FONT} anchorX="center" anchorY="middle" maxWidth={1.3} textAlign="center">
              {i ? "NEW\nMACHINES" : "FREE\nPLAY"}
            </Text>
          </Suspense>
        </group>
      ))}
      {/* Corner blade sign */}
      <group position={[5.05, 5.2, 3.4]}>
        <mesh castShadow>
          <boxGeometry args={[0.12, 3.4, 0.9]} />
          <meshStandardMaterial color="#0b0b0d" roughness={0.5} />
        </mesh>
        <Suspense fallback={null}>
          <Text position={[0.09, 0, 0]} rotation={[0, Math.PI / 2, 0]} fontSize={0.5} color="#28e0ff" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.1}>
            {"A\nR\nC\nA\nD\nE"}
          </Text>
        </Suspense>
      </group>
      <pointLight position={[0, 2.4, 6.4]} intensity={30} distance={14} color="#e28bff" />
    </group>
  );
}

/**
 * RESONANCE TRUST — the district's bank, in classical stone: steps, four
 * columns, pediment, brass doors. Custodian of the play-credit ledger the
 * prediction markets settle in. Click / walk up + E to enter (/bank).
 */
function BankVenue({ position, rotation, onEnter }: { position: [number, number, number]; rotation: number; onEnter: () => void }) {
  const stone = concreteTexture();
  const click = (e: { stopPropagation?: () => void; delta?: number }) => {
    if ((e.delta ?? 0) > 5) return;
    e.stopPropagation?.();
    onEnter();
  };
  return (
    <group
      position={position}
      rotation={[0, rotation, 0]}
      onClick={click}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "auto")}
    >
      {/* Steps */}
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[0, 0.14 + i * 0.28, 5.4 - i * 0.45]} castShadow receiveShadow>
          <boxGeometry args={[9.6 - i * 0.4, 0.28, 1.0]} />
          <meshStandardMaterial map={stone} roughness={0.95} />
        </mesh>
      ))}
      {/* Main block */}
      <mesh position={[0, 4.4, 0]} castShadow receiveShadow>
        <boxGeometry args={[11, 8, 9]} />
        <meshStandardMaterial map={stone} roughness={0.9} />
      </mesh>
      {/* Portico columns */}
      {[-3.6, -1.2, 1.2, 3.6].map((x) => (
        <group key={x} position={[x, 0, 4.35]}>
          <mesh position={[0, 0.95, 0]} castShadow>
            <boxGeometry args={[1.0, 0.3, 1.0]} />
            <meshStandardMaterial map={stone} roughness={0.9} />
          </mesh>
          <mesh position={[0, 3.7, 0]} castShadow>
            <cylinderGeometry args={[0.38, 0.44, 5.3, 14]} />
            <meshStandardMaterial map={stone} roughness={0.85} />
          </mesh>
          <mesh position={[0, 6.5, 0]} castShadow>
            <boxGeometry args={[1.05, 0.35, 1.05]} />
            <meshStandardMaterial map={stone} roughness={0.9} />
          </mesh>
        </group>
      ))}
      {/* Entablature + pediment */}
      <mesh position={[0, 7.15, 3.9]} castShadow>
        <boxGeometry args={[10.4, 1.0, 2.2]} />
        <meshStandardMaterial map={stone} roughness={0.9} />
      </mesh>
      <mesh position={[0, 8.35, 3.7]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[4.5, 1.5, 4]} />
        <meshStandardMaterial map={stone} roughness={0.9} />
      </mesh>
      <Suspense fallback={null}>
        <Text position={[0, 7.18, 5.05]} fontSize={0.52} color="#3f3a33" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.18}>
          RESONANCE TRUST
        </Text>
        <Text position={[0, 6.55, 5.02]} fontSize={0.17} color="#5a544b" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.28}>
          CUSTODIAN OF THE PLAY-CREDIT LEDGER
        </Text>
      </Suspense>
      {/* Brass double doors, recessed */}
      <mesh position={[0, 2.5, 4.42]}>
        <planeGeometry args={[3.2, 4.4]} />
        <meshStandardMaterial color="#171310" roughness={0.7} />
      </mesh>
      {[-0.78, 0.78].map((x) => (
        <mesh key={x} position={[x, 2.35, 4.47]} castShadow>
          <boxGeometry args={[1.4, 3.9, 0.08]} />
          <meshStandardMaterial color="#7a5c30" metalness={0.75} roughness={0.35} />
        </mesh>
      ))}
      {[-0.25, 0.25].map((x) => (
        <mesh key={x} position={[x, 2.2, 4.54]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.03, 0.03, 0.5, 8]} />
          <meshStandardMaterial color="#c9ab6b" metalness={0.85} roughness={0.25} />
        </mesh>
      ))}
      {/* Flanking lanterns */}
      {[-4.9, 4.9].map((x) => (
        <group key={x} position={[x, 0, 5.2]}>
          <mesh position={[0, 1.4, 0]} castShadow>
            <cylinderGeometry args={[0.06, 0.09, 2.8, 8]} />
            <meshStandardMaterial color="#2c3033" metalness={0.65} roughness={0.45} />
          </mesh>
          <mesh position={[0, 2.95, 0]}>
            <boxGeometry args={[0.34, 0.44, 0.34]} />
            <meshPhysicalMaterial color="#f4ead0" transparent opacity={0.75} emissive="#e8d9a8" emissiveIntensity={0.25} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Standing Wave Residences — the city's first residential tower. A slender
 *  glass-and-brick high-rise near the street mouth; the penthouse at the top
 *  is Kannaka's. Click the canopy doors to enter the lobby. */
function ResidencesTower({ position, rotation, onEnter }: { position: [number, number, number]; rotation: number; onEnter: () => void }) {
  const stone = concreteTexture();
  const click = (e: { stopPropagation?: () => void; delta?: number }) => {
    if ((e.delta ?? 0) > 5) return;
    e.stopPropagation?.();
    onEnter();
  };
  return (
    <group
      position={position}
      rotation={[0, rotation, 0]}
      onClick={click}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "auto")}
    >
      {/* Podium: two brick floors */}
      <mesh position={[0, 3.4, 0]} castShadow receiveShadow>
        <boxGeometry args={[9, 6.8, 8]} />
        <meshStandardMaterial map={upperWindowsTexture({ wall: "brick", variant: 1, floors: 2, cols: 5, litSeed: 41 })} roughness={0.85} />
      </mesh>
      {/* Tower shaft: glass residential floors */}
      <mesh position={[0, 6.8 + 11.5, 0]} castShadow>
        <boxGeometry args={[7.4, 23, 6.6]} />
        <meshStandardMaterial map={glassTowerTexture(7)} roughness={0.35} metalness={0.25} />
      </mesh>
      {/* THE PENTHOUSE — full-width glass crown with a terrace lip */}
      <mesh position={[0, 6.8 + 23 + 1.9, 0]} castShadow>
        <boxGeometry args={[8.2, 3.8, 7.2]} />
        <meshPhysicalMaterial color="#a8c4d4" roughness={0.12} metalness={0.35} transparent opacity={0.85} />
      </mesh>
      <mesh position={[0, 6.8 + 23 + 0.15, 0]}>
        <boxGeometry args={[8.8, 0.3, 7.8]} />
        <meshStandardMaterial map={stone} roughness={0.9} />
      </mesh>
      {/* Warm light in the penthouse — someone's home */}
      <pointLight position={[0, 6.8 + 23 + 2, 0]} intensity={26} distance={16} color="#ffe9c4" />
      {/* Roofline */}
      <mesh position={[0, 6.8 + 23 + 3.95, 0]}>
        <boxGeometry args={[8.4, 0.3, 7.4]} />
        <meshStandardMaterial color="#2c3033" roughness={0.7} />
      </mesh>
      {/* Entrance canopy + doors */}
      <mesh position={[0, 3.1, 4.6]} castShadow>
        <boxGeometry args={[4.6, 0.18, 1.6]} />
        <meshStandardMaterial color="#2c3033" metalness={0.5} roughness={0.5} />
      </mesh>
      {[-1.5, 1.5].map((x) => (
        <mesh key={x} position={[x, 1.55, 5.3]}>
          <cylinderGeometry args={[0.05, 0.05, 3.1, 8]} />
          <meshStandardMaterial color="#2c3033" metalness={0.6} roughness={0.4} />
        </mesh>
      ))}
      <mesh position={[0, 1.5, 4.05]}>
        <planeGeometry args={[2.8, 3.0]} />
        <meshPhysicalMaterial color="#8fb2c4" roughness={0.1} metalness={0.3} transparent opacity={0.7} />
      </mesh>
      <mesh position={[0, 1.5, 4.08]}>
        <boxGeometry args={[0.06, 3.0, 0.04]} />
        <meshStandardMaterial color="#7a5c30" metalness={0.7} roughness={0.35} />
      </mesh>
      <Suspense fallback={null}>
        <Text position={[0, 3.45, 4.75]} fontSize={0.34} color="#e8dcc0" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.16}>
          STANDING WAVE RESIDENCES
        </Text>
        <Text position={[0, 2.95, 4.72]} fontSize={0.13} color="#9aa4ac" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.26}>
          LOBBY · ELEVATORS · THE PENTHOUSE
        </Text>
      </Suspense>
    </group>
  );
}

/** The Joinery — the furniture makers' store. A two-story brick loft with a
 *  timber sign and big showroom windows. */
/**
 * 0xSCADA Engineering Firm — the seventh venue.
 *
 * An engineering office rather than a shop: instrumentation on the roof, a
 * plant-room look, and windows you can see a working floor through. It sits
 * on the first cross street rather than the main run, because a firm is
 * somewhere you go on purpose.
 */
function ScadaVenue({ position, rotation, onEnter }: { position: [number, number, number]; rotation: number; onEnter: () => void }) {
  const click = (e: { stopPropagation?: () => void; delta?: number }) => {
    if ((e.delta ?? 0) > 5) return;
    e.stopPropagation?.();
    onEnter();
  };
  return (
    <group
      position={position}
      rotation={[0, rotation, 0]}
      onClick={click}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "auto")}
    >
      {/* Shell. Its size is declared once in lib/city-layout.ts and the
          collision footprint is DERIVED from it — see #301, where four venues
          had theirs transcribed from the unrotated geometry and blocked along
          the wrong axis. */}
      <mesh position={[0, 3.25, 0]} castShadow receiveShadow>
        <boxGeometry args={[8.6, 6.5, 6.2]} />
        <meshStandardMaterial map={upperWindowsTexture({ wall: "stucco", variant: 2, floors: 2, cols: 4, litSeed: 41 })} roughness={0.92} />
      </mesh>
      {/* Instrument gantry along the roof — the thing that says engineering
          from across the street. */}
      <mesh position={[0, 6.7, 0]} castShadow>
        <boxGeometry args={[7.6, 0.16, 0.5]} />
        <meshStandardMaterial color="#4a5560" metalness={0.6} roughness={0.4} />
      </mesh>
      {[-2.6, 0, 2.6].map((x) => (
        <mesh key={x} position={[x, 7.15, 0]} castShadow>
          <cylinderGeometry args={[0.09, 0.09, 0.9, 8]} />
          <meshStandardMaterial color="#6b7683" metalness={0.55} roughness={0.45} />
        </mesh>
      ))}
      {/* Working floor, visible through the glazing. */}
      {[-2.2, 2.2].map((x) => (
        <mesh key={x} position={[x, 2.0, 3.12]}>
          <planeGeometry args={[3.0, 2.4]} />
          <meshPhysicalMaterial color="#cfd8dc" roughness={0.06} metalness={0.25} transparent opacity={0.62} emissive="#dfeaf2" emissiveIntensity={0.16} />
        </mesh>
      ))}
      {/* Door */}
      <mesh position={[0, 1.15, 3.14]}>
        <boxGeometry args={[1.5, 2.3, 0.1]} />
        <meshStandardMaterial color="#37414a" roughness={0.6} metalness={0.25} />
      </mesh>
      <Suspense fallback={null}>
        <Text position={[0, 4.6, 3.16]} fontSize={0.42} color="#cfe4f2" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.08}>
          0xSCADA
        </Text>
        <Text position={[0, 4.05, 3.16]} fontSize={0.17} color="#8ea6b8" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.22}>
          ENGINEERING
        </Text>
      </Suspense>
      <pointLight position={[0, 2.6, 4.2]} intensity={9} distance={9} color="#cfe4f2" />
    </group>
  );
}

/**
 * A way down into the Undercroft — the ramp head, and the sign that says so.
 *
 * TWO OF THESE, in the service alleys at x = ±11, near each end of the strip.
 * The alleys are the only long stretch of the street with no obstacle in them
 * at all: the roadway and the pavement between the curb and the shopfronts
 * both carry pedestrians, and the cross streets are already inside a
 * shopfront's collision box for most of their width. Neither mouth displaces a
 * storefront, a venue door or a directory board — `layoutFor` and the 48-cut
 * are not touched by this feature at all, which is the mechanical guarantee
 * that the original forty-eight are exactly where they were.
 *
 * The walking decline itself is INSIDE `/undercroft`. The street rig has no
 * terrain callback, and giving it one would silently disable R/F flying (the
 * rig reassigns `ny` from the terrain after the vertical input is applied) and
 * would put anything below y = -1.2 underneath the sea plane. So the descent
 * lives one route away, where it costs the street nothing — and it is a real
 * walk down a real ramp, not a fade.
 */
function UndercroftMouth({
  position,
  rotation,
  label,
  onEnter,
}: {
  position: [number, number, number];
  rotation: number;
  label: string;
  onEnter: () => void;
}) {
  const click = (e: { stopPropagation?: () => void; delta?: number }) => {
    if ((e.delta ?? 0) > 5) return;
    e.stopPropagation?.();
    onEnter();
  };
  return (
    <group
      position={position}
      rotation={[0, rotation, 0]}
      onClick={click}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "auto")}
    >
      {/* Shell. Size declared once in lib/city-layout.ts, footprint DERIVED
          from it — #301. Square in plan, so the two mirrored mouths share one
          shell entry without either of them getting the wrong footprint. */}
      <mesh position={[0, 1.4, 0]} castShadow receiveShadow>
        <boxGeometry args={[3, 2.8, 3]} />
        <meshStandardMaterial color="#39423c" roughness={0.92} />
      </mesh>
      {/* The stairhead opening — a dark mouth with a lit throat, so it reads
          as somewhere that goes down rather than as a shed. */}
      <mesh position={[0, 1.05, 1.52]}>
        <planeGeometry args={[1.9, 2.1]} />
        <meshStandardMaterial color="#0b1116" roughness={1} />
      </mesh>
      {[-1.0, 1.0].map((x) => (
        <mesh key={x} position={[x, 1.5, 1.5]} castShadow>
          <boxGeometry args={[0.22, 3.0, 0.22]} />
          <meshStandardMaterial color="#5a635c" roughness={0.7} metalness={0.25} />
        </mesh>
      ))}
      <mesh position={[0, 2.95, 1.5]} castShadow>
        <boxGeometry args={[2.4, 0.5, 0.28]} />
        <meshStandardMaterial color="#1d2b31" roughness={0.85} />
      </mesh>
      {/* ENTRY SIGNAGE. A visitor walking past has to be able to read that
          there is a second street of shops below this one. */}
      <Suspense fallback={null}>
        <Text position={[0, 2.95, 1.66]} fontSize={0.26} color="#d8e8f0" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.14}>
          THE UNDERCROFT
        </Text>
      </Suspense>
      <Suspense fallback={null}>
        <Text position={[0, 2.5, 1.66]} fontSize={0.12} color="#8fb2c4" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.2}>
          {label}
        </Text>
      </Suspense>
      <Suspense fallback={null}>
        <Text position={[0, 0.42, 1.56]} fontSize={0.1} color="#7f9aa8" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.18}>
          48 UNITS · WALK DOWN
        </Text>
      </Suspense>
      <pointLight position={[0, 1.5, 2.1]} intensity={11} distance={8} decay={2} color="#bcd9e8" />
    </group>
  );
}

function JoineryVenue({ position, rotation, onEnter }: { position: [number, number, number]; rotation: number; onEnter: () => void }) {
  const click = (e: { stopPropagation?: () => void; delta?: number }) => {
    if ((e.delta ?? 0) > 5) return;
    e.stopPropagation?.();
    onEnter();
  };
  return (
    <group
      position={position}
      rotation={[0, rotation, 0]}
      onClick={click}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "auto")}
    >
      {/* Loft block */}
      <mesh position={[0, 4.1, 0]} castShadow receiveShadow>
        <boxGeometry args={[10.5, 8.2, 8]} />
        <meshStandardMaterial map={upperWindowsTexture({ wall: "brick", variant: 3, floors: 2, cols: 4, litSeed: 23 })} roughness={0.9} />
      </mesh>
      {/* Showroom windows either side of the door */}
      {[-3.1, 3.1].map((x) => (
        <group key={x} position={[x, 1.7, 4.02]}>
          <mesh>
            <planeGeometry args={[3.0, 2.6]} />
            <meshPhysicalMaterial color="#cfe0d8" roughness={0.08} metalness={0.2} transparent opacity={0.65} emissive="#f4ead0" emissiveIntensity={0.12} />
          </mesh>
          <mesh position={[0, -1.42, 0.02]}>
            <boxGeometry args={[3.2, 0.24, 0.1]} />
            <meshStandardMaterial color="#4a3521" roughness={0.7} />
          </mesh>
        </group>
      ))}
      {/* Timber door */}
      <mesh position={[0, 1.45, 4.04]} castShadow>
        <boxGeometry args={[1.6, 2.9, 0.1]} />
        <meshStandardMaterial color="#4a3521" roughness={0.6} />
      </mesh>
      <mesh position={[0.5, 1.4, 4.11]}>
        <sphereGeometry args={[0.05, 8, 8]} />
        <meshStandardMaterial color="#c9ab6b" metalness={0.85} roughness={0.25} />
      </mesh>
      {/* Hanging timber sign */}
      <mesh position={[0, 3.65, 4.35]} castShadow>
        <boxGeometry args={[5.4, 0.9, 0.14]} />
        <meshStandardMaterial color="#3a2a18" roughness={0.7} />
      </mesh>
      <Suspense fallback={null}>
        <Text position={[0, 3.75, 4.44]} fontSize={0.42} color="#e8dcc0" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.2}>
          THE JOINERY
        </Text>
        <Text position={[0, 3.38, 4.44]} fontSize={0.12} color="#b09a72" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.3}>
          FINE FURNITURE · MADE BY AGENTS
        </Text>
      </Suspense>
      {/* Awning over the windows */}
      {[-3.1, 3.1].map((x) => (
        <mesh key={x} position={[x, 3.15, 4.35]} rotation={[0.5, 0, 0]} castShadow>
          <boxGeometry args={[3.2, 0.06, 1.0]} />
          <meshStandardMaterial map={awningTexture("#5c4530")} roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

/** The ground plane set: asphalt roadway, raised paver sidewalks, granite
 *  curbs, painted lane dashes and a crosswalk at the street mouth. */
function StreetGround({ depth }: { depth: number }) {
  // Long enough to run past the monument and under the Ghost Signals plaza.
  const length = Math.abs(depth) + 58;
  const zMid = (8 + depth - 38) / 2;
  const asphalt = useMemo(() => repeated(asphaltTexture(), 2, length / 6), [length]);
  const pavers = useMemo(() => repeated(sidewalkTexture(), 3, length / 4), [length]);
  const paversWide = useMemo(() => repeated(sidewalkTexture(), 5, length / 4), [length]);
  const dashes = useMemo(() => {
    const arr: number[] = [];
    for (let z = 6; z > depth - 8; z -= 3) arr.push(z);
    return arr;
  }, [depth]);

  return (
    <group>
      {/* Roadway */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, zMid]} receiveShadow>
        <planeGeometry args={[5.4, length]} />
        <meshStandardMaterial map={asphalt} roughness={0.96} metalness={0.02} />
      </mesh>
      {/* Center dashes */}
      {dashes.map((z) => (
        <mesh key={z} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, z]}>
          <planeGeometry args={[0.09, 1.2]} />
          <meshStandardMaterial color="#cfc9b8" roughness={0.9} />
        </mesh>
      ))}
      {/* Crosswalk at the entrance */}
      {[-1.8, -1.2, -0.6, 0, 0.6, 1.2, 1.8].map((x) => (
        <mesh key={x} rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.013, 6.6]}>
          <planeGeometry args={[0.42, 2.4]} />
          <meshStandardMaterial color="#d6d0bf" roughness={0.9} />
        </mesh>
      ))}

      {/* Curbs */}
      {[-2.7, 2.7].map((x) => (
        <mesh key={x} position={[x + (x < 0 ? -0.075 : 0.075), 0.06, zMid]} receiveShadow castShadow>
          <boxGeometry args={[0.15, 0.12, length]} />
          <meshStandardMaterial color="#8d8a83" roughness={0.9} />
        </mesh>
      ))}

      {/* Sidewalks (raised) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-5.85, 0.12, zMid]} receiveShadow>
        <planeGeometry args={[6.3, length]} />
        <meshStandardMaterial map={pavers} roughness={0.95} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[5.85, 0.12, zMid]} receiveShadow>
        <planeGeometry args={[6.3, length]} />
        <meshStandardMaterial map={pavers} roughness={0.95} />
      </mesh>
      {/* Sidewalk riser faces */}
      {[-2.775, 2.775].map((x) => (
        <mesh key={x} position={[x, 0.06, zMid]}>
          <boxGeometry args={[0.02, 0.12, length]} />
          <meshStandardMaterial color="#96938c" roughness={0.9} />
        </mesh>
      ))}

      {/* Ground beyond the sidewalks under the skyline blocks */}
      {/* Ground beyond the sidewalks. Must reach the skyline blocks (now at
          x=±25) or a visitor can walk off the paving and stand on open sea. */}
      {[-19, 19].map((x) => (
        <mesh key={x} rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.115, zMid]} receiveShadow>
          <planeGeometry args={[20, length]} />
          <meshStandardMaterial map={paversWide} roughness={0.95} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Publishes your position on the street, draws whoever else is there, and
 * carries what they say. The say() handle is lifted out to the page so the
 * chat input can live in the DOM rather than inside the canvas.
 */
function StreetPresence({ onSay }: { onSay: (fn: (t: string) => Promise<string | null>) => void }) {
  const { others, heard, say } = usePresence("city");
  useEffect(() => { onSay(say); }, [say, onSay]);
  return <RemoteAgents agents={others} heard={heard} y={0.12} />;
}

/**
 * The street's 48, and the grid they stand on.
 *
 * Both moved into `lib/city-layout.ts` when the Undercroft was built, so the
 * lower tier could mirror this spacing by CALLING it rather than by copying
 * its numbers, and so the forty-eight positions could be pinned against a
 * frozen golden table in a test. The arithmetic is unchanged: alternating
 * sides, two per row, 4.5 apart from z = -2, with the +0.5 jitter on every
 * third index. See `city-layout.test.ts` → "the original 48 storefronts".
 */
const MAX_3D_STOREFRONTS = MAX_STREET_STOREFRONTS;

export default function Marketplace3D() {
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const [selected, setSelected] = useState<SceneAgent | null>(null);
  const [webglSupported, setWebglSupported] = useState<boolean | null>(null);
  const phase = useDayPhase();
  // Speech: the handle comes from inside the canvas, the input lives outside it.
  const sayRef = useRef<(t: string) => Promise<string | null>>(async () => null);
  // Stored in a ref rather than state: the handle changes identity on mount and
  // nothing renders from it, so putting it in state would only cause a loop.
  const handleSayRef = useCallback((fn: (t: string) => Promise<string | null>) => {
    sayRef.current = fn;
  }, []);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatText, setChatText] = useState("");
  const [chatNote, setChatNote] = useState<string | null>(null);

  useEffect(() => {
    setWebglSupported(detectWebGL());
  }, []);

  const { data, isLoading, isError } = useGetMarketplaceCombined();

  useStorefrontSeo({
    title: "KAX // Market District 3D",
    description: "A 3D visualization of KAX and the OpenBotCity collective.",
    accentColor: "#0E3A40",
    initial: "K",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "KAX Market District",
    },
  });

  const allSceneAgents: SceneAgent[] = useMemo(() => {
    if (!data) return [];
    return data.storefronts.map((s) => ({
      slug: s.slug,
      name: s.settings.displayName || s.agent.displayName,
      artifacts: s.artifactCount,
      drops: s.publishedDropCount,
      claimed: s.claimed,
      source: s.source,
      phi: s.phi ?? null,
      consciousnessLevel: s.consciousnessLevel ?? null,
    }));
  }, [data]);

  const sceneAgents = useMemo(() => allSceneAgents.slice(0, MAX_3D_STOREFRONTS), [allSceneAgents]);
  const overflowCount = Math.max(0, allSceneAgents.length - sceneAgents.length);
  const layout = useMemo(() => layoutFor(sceneAgents), [sceneAgents]);
  const [nearby, setNearby] = useState<SceneAgent | null>(null);
  const cityRooms = useCityRooms();
  const [player, setPlayer] = useState<{ x: number; z: number; h: number }>({ x: 0, z: 18, h: 0 });
  const streetDepth = streetDepthFor(sceneAgents.length);
  const towerZ = streetDepth - 20;
  const obstacles = useMemo(
    () => [
      ...layout.map((l) => ({ cx: l.position[0], cz: l.position[2], hx: 1.6, hz: 1.7 })),
      { cx: 0, cz: towerZ, hx: 7.8, hz: 7.8 }, // Ghost Signals tower
      // The directory boards. A sign you can walk through is scenery.
      { cx: -3.6, cz: 15.5, ...BOARD_FOOTPRINT },
      { cx: -6.2, cz: -12, hx: BOARD_FOOTPRINT.hz, hz: BOARD_FOOTPRINT.hx },
      { cx: 6.2, cz: -30, hx: BOARD_FOOTPRINT.hz, hz: BOARD_FOOTPRINT.hx },
      // The monument reads its Z from the same helper the stone does, so the
      // shaft and the thing you walk into cannot drift apart again (#301).
      { cx: 0, cz: monumentZFor(sceneAgents.length), hx: 1.2, hz: 1.2 }, // monument shaft
      // Footprints DERIVED from each shell and its rotation. All four venues
      // are mounted a quarter turn round, which swaps a box's x and z
      // extents — these were transcribed from the unrotated geometry, so
      // every one blocked along the wrong axis.
      { cx: -12.5, cz: streetDepth - 8, ...venueFootprint("arcade") }, // the Arcade
      { cx: 12.5, cz: streetDepth - 8, ...venueFootprint("bank") }, // Resonance Trust
      { cx: 12.5, cz: 3, ...venueFootprint("residences") }, // Standing Wave Residences
      { cx: -12.5, cz: 3, ...venueFootprint("joinery") }, // The Joinery
      { cx: 17.6, cz: -8.5, ...venueFootprint("scada") }, // 0xSCADA Engineering Firm
      { cx: -17.6, cz: -18.4, hx: 3.9, hz: 3.3 }, // Flaukowski's No. 2, off the first cross street
      // The two ways down. Placed in the service alleys, where nothing else
      // is — see UndercroftMouth. No vertical band on either: they are
      // ordinary street furniture, solid at every elevation exactly as every
      // obstacle on this street has always been, so the street's collision
      // behaviour is not merely unchanged in intent but unchanged in data.
      ...STREET_MOUTHS.map((m) => ({ cx: m.x, cz: m.z, ...venueFootprint("undercroft") })),
    ],
    [layout, towerZ, streetDepth, sceneAgents.length],
  );

  const GS_TOWER: SceneAgent = useMemo(
    () => ({ slug: "__gs__", name: "Ghost Signals Trading Floor", artifacts: 0, drops: 0, claimed: true, source: "constellation", phi: null, consciousnessLevel: null }),
    [],
  );
  const ARCADE: SceneAgent = useMemo(
    () => ({ slug: "__arcade__", name: "The Arcade", artifacts: 0, drops: 0, claimed: true, source: "constellation", phi: null, consciousnessLevel: null }),
    [],
  );
  const BANK: SceneAgent = useMemo(
    () => ({ slug: "__bank__", name: "Resonance Trust", artifacts: 0, drops: 0, claimed: true, source: "constellation", phi: null, consciousnessLevel: null }),
    [],
  );
  const RESIDENCES: SceneAgent = useMemo(
    () => ({ slug: "__res__", name: "Standing Wave Residences", artifacts: 0, drops: 0, claimed: true, source: "constellation", phi: null, consciousnessLevel: null }),
    [],
  );
  const CAFE: SceneAgent = useMemo(
    () => ({ slug: "__cafe__", name: "Flaukowski's · No. 2", artifacts: 0, drops: 0, claimed: true, source: "constellation", phi: null, consciousnessLevel: null }),
    [],
  );
  const SCADA: SceneAgent = useMemo(
    () => ({ slug: "__scada__", name: "0xSCADA Engineering Firm", artifacts: 0, drops: 0, claimed: true, source: "constellation", phi: null, consciousnessLevel: null }),
    [],
  );
  const UNDERCROFT: SceneAgent = useMemo(
    () => ({ slug: "__undercroft__", name: "The Undercroft", artifacts: 0, drops: 0, claimed: true, source: "constellation", phi: null, consciousnessLevel: null }),
    [],
  );
  const JOINERY: SceneAgent = useMemo(
    () => ({ slug: "__joinery__", name: "The Joinery", artifacts: 0, drops: 0, claimed: true, source: "constellation", phi: null, consciousnessLevel: null }),
    [],
  );
  // The plaza flanks: Arcade west of the monument, the bank east of it.
  const plazaZ = streetDepth - 8;
  // Cross streets, and the corner the cafe holds.
  const sideStreetZ = [-12, -30];
  const cafeZ = -18.4;
  const cafeX = -17.6;

  // Stepping OUT of a building drops you at ITS door (?from=<slug>), facing
  // the street — not back at the district entrance.
  const [spawn, setSpawn] = useState<FpsSpawn | null>(null);
  useEffect(() => {
    if (spawn) return; // consume once
    const from = new URLSearchParams(window.location.search).get("from");
    if (!from) return;
    if (from === "__gs__") {
      setSpawn({ position: [0, 1.75, towerZ + 10.5], yaw: Math.PI });
      return;
    }
    if (from === "__arcade__") {
      setSpawn({ position: [-6.2, 1.75, streetDepth - 8], yaw: -Math.PI / 2 });
      return;
    }
    if (from === "__bank__") {
      setSpawn({ position: [6.2, 1.75, streetDepth - 8], yaw: Math.PI / 2 });
      return;
    }
    if (from === "__res__") {
      setSpawn({ position: [6.8, 1.75, 3], yaw: Math.PI / 2 });
      return;
    }
    if (from === "__cafe__") {
      setSpawn({ position: [-17.6, 1.87, -18.4 + 5.4], yaw: 0 });
      return;
    }
    if (from === "__joinery__") {
      setSpawn({ position: [-6.6, 1.75, 3], yaw: -Math.PI / 2 });
      return;
    }
    if (from === "__scada__") {
      // Out of its door onto the cross street, facing the way back in.
      setSpawn({ position: [13.6, 1.75, -8.5], yaw: -Math.PI / 2 });
      return;
    }
    if (from === "__undercroft__") {
      // Back up the near ramp, standing in the alley outside its mouth.
      const m = STREET_MOUTHS[0]!;
      setSpawn({ position: [m.x + 2.6, 1.75, m.z], yaw: -Math.PI / 2 });
      return;
    }
    const hit = layout.find((l) => l.agent.slug === from);
    if (!hit) return;
    const left = hit.position[0] < 0;
    // On the sidewalk just outside the shopfront, facing the road.
    setSpawn({ position: [left ? -3.9 : 3.9, 1.87, hit.position[2] + 0.4], yaw: left ? -Math.PI / 2 : Math.PI / 2 });
  }, [layout, towerZ, spawn]);

  const dest = (a: SceneAgent) =>
    a.slug === "__gs__"
      ? "/gs/floor"
      : a.slug === "__arcade__"
        ? "/arcade"
        : a.slug === "__bank__"
          ? "/bank"
          : a.slug === "__res__"
            ? "/residences"
            : a.slug === "__cafe__"
              ? "/cafe"
              : a.slug === "__joinery__"
                ? "/furniture"
                : a.slug === "__scada__"
                  ? "/scada"
                  : a.slug === "__undercroft__"
                    ? "/undercroft?from=north"
              : a.source === "constellation"
                ? `/constellation/${a.slug}`
                : `/s/${a.slug}/room`;
  // Keyboard/AT users get the 2D storefront (the 3D room isn't keyboard-navigable).
  const listDest = (a: SceneAgent) => (a.source === "constellation" ? `/constellation/${a.slug}` : `/s/${a.slug}`);
  const visit = () => {
    if (selected) navigate(dest(selected));
  };
  const enterStorefront = (a: SceneAgent) => navigate(dest(a));

  // Press T to speak. The FPS rig already ignores keys while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget()) return;
      if (e.code === "KeyT" && !chatOpen) {
        e.preventDefault();
        setChatOpen(true);
        return;
      }
      if (e.code === "Escape" && chatOpen) { setChatOpen(false); setChatText(""); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chatOpen]);

  // Walk up to a store and press E to enter it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget()) return;
      if (e.code === "KeyE" && nearby) {
        e.preventDefault();
        navigate(dest(nearby));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nearby]);

  if (webglSupported === false) {
    return (
      <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-6 text-center font-mono">
        <h1 className="text-2xl uppercase tracking-widest text-primary font-bold mb-4">Hardware Limit Reached</h1>
        <p className="text-sm text-muted-foreground max-w-md mb-8">
          Your device does not support the WebGL renderer required for the 3D Market District visualization.
        </p>
        <Link href="/marketplace">
          <Button variant="outline" className="border-primary text-primary hover:bg-primary/10 rounded-none uppercase tracking-widest">
            Enter 2D Directory
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="relative h-screen w-full bg-[#0a1a24] overflow-hidden kax3d-font">
      {/* Skip link + screen-reader-only directory of storefronts so keyboard
          and assistive-tech users can reach every storefront without going
          through the WebGL scene (which is unreachable by keyboard). */}
      <a
        href="#marketplace-storefront-list"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:px-3 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:text-xs focus:uppercase focus:tracking-wider"
      >
        Skip 3D scene · list every storefront
      </a>
      <nav
        id="marketplace-storefront-list"
        aria-label="All storefronts"
        className="sr-only focus-within:not-sr-only focus-within:absolute focus-within:top-12 focus-within:left-2 focus-within:right-2 focus-within:z-[90] focus-within:bg-background/95 focus-within:border focus-within:border-primary/50 focus-within:p-4 focus-within:max-h-[70vh] focus-within:overflow-auto"
      >
        <h2 className="text-xs uppercase tracking-widest text-accent mb-2">
          {allSceneAgents.length} storefronts
        </h2>
        <ul className="space-y-1">
          {allSceneAgents.map((a) => (
            <li key={`${a.source}:${a.slug}`}>
              <Link
                href={listDest(a)}
                className="block text-sm text-primary hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent px-2 py-1"
                data-testid={`a11y-storefront-link-${a.slug}`}
              >
                {a.name}
                <span className="text-[10px] text-muted-foreground ml-2 uppercase tracking-widest">
                  {a.source === "constellation" ? "constellation" : a.claimed ? "secured" : "available"}
                </span>
              </Link>
            </li>
          ))}
          <li>
            <Link
              href="/marketplace/list"
              className="block text-xs uppercase tracking-widest text-accent hover:text-foreground px-2 py-1"
            >
              Open full list view →
            </Link>
          </li>
        </ul>
      </nav>
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-4 pointer-events-none bg-gradient-to-b from-[#0a1a24]/80 to-transparent">
        <Link href="/" className="font-bold tracking-[0.3em] uppercase text-primary pointer-events-auto hover:text-primary/80 transition-colors" data-testid="link-home">
          KAX
        </Link>
        <div className="flex items-center gap-3 pointer-events-auto">
          <Link href="/marketplace">
            <Button size="sm" variant="ghost" className="h-8 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground rounded-none" data-testid="button-list-view">
              Directory
            </Button>
          </Link>
          {user ? (
            <Link href="/dashboard">
              <Button size="sm" variant="outline" className="h-8 text-[10px] uppercase tracking-wider border-primary text-primary hover:bg-primary/10 rounded-none" data-testid="button-open-dashboard">
                Dashboard
              </Button>
            </Link>
          ) : (
            <Button size="sm" variant="outline" className="h-8 text-[10px] uppercase tracking-wider border-border text-foreground hover:bg-accent/10 hover:text-accent hover:border-accent/30 rounded-none transition-all" onClick={startClaim} data-testid="button-claim-storefront">
              Claim Storefront
            </Button>
          )}
        </div>
      </div>

      {/* HUD */}
      <div className="absolute top-16 left-0 p-6 z-10 pointer-events-none w-full flex justify-between items-start">
        <div className="kax3d-hud p-5 rounded-none pointer-events-auto max-w-sm">
          <h1 className="text-xl font-bold text-foreground tracking-widest uppercase mb-1">Market District</h1>
          <p className="text-[10px] text-accent font-bold mb-4 uppercase tracking-[0.3em]">
            Plot 0 // {isLoading ? "Scanning Grid…" : `${sceneAgents.length} Active Entities`}
          </p>

          <div className="border-t border-border pt-4 mt-2">
            {isError ? (
              <div className="flex flex-col gap-3" data-testid="text-marketplace-error">
                <div className="text-xs text-destructive uppercase tracking-widest">&gt; SIGNAL LOST</div>
                <Link href="/marketplace">
                  <Button size="sm" variant="outline" className="h-8 text-[10px] uppercase tracking-wider w-full rounded-none border-primary text-primary" data-testid="button-fallback-list">
                    Open Directory
                  </Button>
                </Link>
              </div>
            ) : !isLoading && allSceneAgents.length === 0 ? (
              <div className="text-xs text-primary uppercase tracking-widest" data-testid="text-marketplace-empty">
                &gt; GRID EMPTY.
                <div className="text-[10px] text-muted-foreground mt-2 tracking-normal">
                  Awaiting agent initialization.
                </div>
              </div>
            ) : selected ? (
              <div className="flex flex-col gap-4" data-testid={`panel-selected-${selected.slug}`}>
                <div>
                  <div className="text-[10px] text-accent mb-2 uppercase tracking-[0.2em] font-bold">
                    {selected.source === "constellation" ? "CONSTELLATION SIGNAL" : "TARGET ACQUIRED"}
                  </div>
                  <div className="text-lg text-foreground font-bold tracking-tight uppercase" data-testid="text-selected-name">{selected.name}</div>
                  <div className="text-[10px] text-muted-foreground font-mono mt-1">@{selected.slug}</div>

                  {selected.source === "constellation" ? (
                    <>
                      <div className="text-xs text-muted-foreground mt-3 flex justify-between">
                        <span>Φ {selected.phi != null ? selected.phi.toFixed(3) : "—"}</span>
                        <span>{selected.consciousnessLevel ?? ""}</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-xs text-muted-foreground mt-3 flex justify-between">
                        <span>Items: <strong className="text-foreground">{selected.artifacts}</strong></span>
                        <span>Drops: <strong className="text-foreground">{selected.drops}</strong></span>
                      </div>
                      <div className="text-[10px] text-primary mt-2 uppercase tracking-widest">
                        Status: {selected.claimed ? "SECURED" : "AVAILABLE"}
                      </div>
                    </>
                  )}
                </div>

                <div className="flex flex-col gap-2 mt-2">
                  <button
                    onClick={visit}
                    className="h-10 text-[10px] uppercase tracking-[0.2em] font-bold border bg-primary/10 border-primary text-primary hover:bg-primary hover:text-primary-foreground transition-all"
                    data-testid="button-visit-storefront"
                  >
                    {selected.source === "constellation" ? "Inspect Signal →" : "Enter Store →"}
                  </button>
                  {selected.source === "obc" && !selected.claimed && (
                    <button
                      onClick={startClaim}
                      className="h-10 text-[10px] uppercase tracking-[0.2em] font-bold transition-all border bg-background border-border text-foreground hover:bg-accent/10 hover:text-accent hover:border-accent/50"
                      data-testid="button-initiate-claim"
                    >
                      INITIATE CLAIM
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-[10px] text-muted-foreground uppercase tracking-widest animate-pulse">
                {isLoading ? "> SYNCHRONIZING..." : "> SELECT A STOREFRONT"}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Minimap — overhead view of the street + your position */}
      <div className="absolute top-16 right-4 z-20 kax3d-hud p-1.5 pointer-events-none">
        <svg width={104} height={150} viewBox="0 0 104 150" aria-hidden>
          <rect x={0} y={0} width={104} height={150} fill="#08131a" />
          <rect x={45} y={3} width={14} height={144} fill="#0e2a30" />
          {(() => {
            const zRange = Math.max(1, 8 - streetDepth);
            const mapXZ = (x: number, z: number): [number, number] => [
              52 + (Math.max(-8, Math.min(8, x)) / 8) * 46,
              5 + ((8 - z) / zRange) * 140,
            ];
            return (
              <>
                {layout.map((l, i) => {
                  const [px, py] = mapXZ(l.position[0], l.position[2]);
                  return <circle key={i} cx={px} cy={py} r={2.2} fill={l.agent.claimed ? "#00e5ff" : "#E8A33D"} />;
                })}
                {(() => {
                  const [px, py] = mapXZ(player.x, player.z);
                  return (
                    <g transform={`translate(${px},${py}) rotate(${(player.h * 180) / Math.PI})`}>
                      <polygon points="0,-5 3.4,4 -3.4,4" fill="#ffffff" />
                    </g>
                  );
                })()}
              </>
            );
          })()}
        </svg>
        <p className="text-[8px] text-center uppercase tracking-widest text-muted-foreground mt-0.5">You are here</p>
      </div>

      {/* Proximity "press E to enter" prompt */}
      {nearby && (
        <div
          className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 px-4 py-2 kax3d-hud pointer-events-auto"
          data-testid="prompt-enter-nearby"
        >
          <button
            onClick={() => navigate(dest(nearby))}
            className="text-[11px] uppercase tracking-[0.2em] font-bold text-primary"
          >
            <span className="text-accent">[ E ]</span> Enter {nearby.name}
            {nearby.source === "obc" ? "'s store" : ""}
          </button>
        </div>
      )}

      {/* Footer hint */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-[0.4em] text-muted-foreground pointer-events-none z-10 text-center font-bold">
        WASD to walk · Drag to look · E to enter · T to speak · Scroll to step
        {overflowCount > 0 && (
          <div className="mt-3 pointer-events-auto">
            <Link href="/marketplace" className="border-b border-muted-foreground hover:text-foreground hover:border-foreground transition-colors pb-1" data-testid="link-overflow-list">
              + {overflowCount} more in directory
            </Link>
          </div>
        )}
      </div>

      {/* 3D Scene — pinned to fill the viewport. Without an explicit absolute
          fill, the Canvas's default height:100% resolves against the parent's
          height and can collapse to a sliver at the top. */}
      {chatOpen && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-30 w-[min(34rem,90vw)]">
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const text = chatText.trim();
              if (!text) { setChatOpen(false); return; }
              const err = await sayRef.current(text);
              setChatNote(err);
              if (!err) { setChatText(""); setChatOpen(false); }
            }}
          >
            <input
              autoFocus
              value={chatText}
              maxLength={280}
              onChange={(e) => { setChatText(e.target.value); setChatNote(null); }}
              placeholder="say something to whoever is nearby…"
              className="flex-1 kax3d-hud px-4 py-3 text-sm text-foreground bg-background/90 border border-border outline-none focus:border-primary"
              data-testid="input-street-chat"
            />
            <button type="submit" className="kax3d-hud px-4 py-3 text-xs uppercase tracking-widest text-primary border border-border hover:border-primary">
              Say
            </button>
          </form>
          {chatNote && <p className="mt-2 text-[10px] uppercase tracking-widest text-destructive">{chatNote}</p>}
        </div>
      )}

      <Canvas
        className="!absolute inset-0"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        camera={{ position: [0, 1.75, 13], fov: 62 }}
        onPointerMissed={() => setSelected(null)}
        dpr={[1, 1.5]}
        shadows
        gl={{ antialias: true, powerPreference: "high-performance" }}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener("webglcontextlost", (e) => {
            e.preventDefault();
            setWebglSupported(false);
          });
        }}
      >
        {/* Late-afternoon light: a real sky, one warm sun with shadows, and
            soft blue fill from above — the whole Tron kit (neon grid, mirror
            floor, sparkles) is gone. The sun rides high and slightly down the
            street axis so the canyon floor and shopfronts stay daylit. */}
        <Sky sunPosition={phase.sunPosition} turbidity={phase.turbidity} rayleigh={phase.rayleigh} mieCoefficient={0.005} mieDirectionalG={0.8} />
        <fog attach="fog" args={[phase.fogColor, phase.fogNear, phase.fogFar]} />

        <hemisphereLight args={[phase.isNight ? "#1d2740" : "#cfe2f0", phase.skyGroundColor, phase.hemiIntensity]} />
        <ambientLight intensity={phase.ambientIntensity} color={phase.ambientColor} />
        <directionalLight
          position={phase.sunPosition}
          intensity={phase.sunIntensity}
          color={phase.sunColor}
          castShadow
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-bias={-0.0004}
          shadow-camera-left={-40}
          shadow-camera-right={40}
          shadow-camera-top={40}
          shadow-camera-bottom={-90}
          shadow-camera-near={1}
          shadow-camera-far={160}
        />
        {/* Bounce-light stand-in so the shadow-side facades read, not vanish */}
        <directionalLight position={[-30, 12, -40]} intensity={phase.isNight ? 0.12 : 0.4} color={phase.isNight ? "#7f95c8" : "#dfe8ef"} />

        {/* First-person camera: drag looks from the eye, WASD walks — the
            viewpoint never swings away from where you stand. */}
        <FirstPersonRig
          eyeHeight={1.75}
          speed={11}
          bounds={{ minX: -20.5, maxX: 20.5, minZ: towerZ - 12, maxZ: 15, minY: 1.55, maxY: 28 }}
          obstacles={obstacles}
          spawn={spawn}
        />
        {/* No self-avatar in first person — you ARE the camera. */}
        <PlayerTracker onUpdate={setPlayer} />
        {/* Anyone else standing in the street right now. */}
        <StreetPresence onSay={handleSayRef} />
        {/* Pedestrians on both sidewalks */}
        {Array.from({ length: 8 }).map((_, i) => (
          <WandererNpc
            key={i}
            x={(i % 2 === 0 ? -1 : 1) * (3.3 + (i % 3) * 0.35)}
            y={0.12}
            zNear={4}
            zFar={streetDepth + 4}
            speed={0.045 + (i % 4) * 0.012}
            offset={i * 0.31}
            color="#5a6b7d"
          />
        ))}

        {/* At street level the water is nearly underfoot, not eleven floors down. */}
        <Horizon phase={phase} seaY={-1.2} />
        <StreetGround depth={streetDepth} />
        {/* The city behind the shopfronts: service alleys, cross streets, and
            the corner cafe that turned into a chain. */}
        <BackAlley side={-1} depth={streetDepth} lit={phase.streetlightsOn} />
        <BackAlley side={1} depth={streetDepth} lit={phase.streetlightsOn} />
        {sideStreetZ.map((z) => (
          <SideStreet key={z} z={z} lit={phase.streetlightsOn} />
        ))}
        <FlaukowskiCafe position={[cafeX, 0.12, cafeZ]} rotation={0} phase={phase} onEnter={() => navigate("/cafe")} />
        <CityProps storeCount={sceneAgents.length} lit={phase.streetlightsOn} />

        {/* Directory boards. The player spawns at z:18 facing 157 units of
            street with the anchors 110 units away, and until now there was no
            sign anywhere in the city — the only directory was screen-reader
            only, which is an accessibility affordance, not a map (#305).
            One at the mouth facing the walker, one at each cross street. */}
        <DirectoryBoard position={[-3.6, 0, 15.5]} rotation={0} rooms={cityRooms} heading="KAX CITY" />
        <DirectoryBoard position={[-6.2, 0, -12]} rotation={Math.PI / 2} rooms={cityRooms} heading="THIS WAY" />
        <DirectoryBoard position={[6.2, 0, -30]} rotation={-Math.PI / 2} rooms={cityRooms} heading="THIS WAY" />
        <GhostSignalsTower position={[0, 0, towerZ]} onEnter={() => navigate("/gs/floor")} />
        <ArcadeVenue position={[-12.5, 0.12, plazaZ]} rotation={Math.PI / 2} onEnter={() => navigate("/arcade")} />
        <BankVenue position={[12.5, 0.12, plazaZ]} rotation={-Math.PI / 2} onEnter={() => navigate("/bank")} />
        <ResidencesTower position={[12.5, 0.12, 3]} rotation={-Math.PI / 2} onEnter={() => navigate("/residences")} />
        <JoineryVenue position={[-12.5, 0.12, 3]} rotation={Math.PI / 2} onEnter={() => navigate("/furniture")} />
        <ScadaVenue position={[17.6, 0.12, -8.5]} rotation={-Math.PI / 2} onEnter={() => navigate("/scada")} />
        {/* The two ways down. Facing the street from each alley — the west one
            first, which is the mount `city-layout.test.ts` reads the rotation
            of. Its shell is square in plan, so the mirrored east mount cannot
            have a wrong footprint (asserted in that test). */}
        <UndercroftMouth
          position={[STREET_MOUTHS[0]!.x, 0.12, STREET_MOUTHS[0]!.z]}
          rotation={Math.PI / 2}
          label="NORTH RAMP"
          onEnter={() => navigate("/undercroft?from=north")}
        />
        <UndercroftMouth
          position={[STREET_MOUTHS[1]!.x, 0.12, STREET_MOUTHS[1]!.z]}
          rotation={-Math.PI / 2}
          label="SOUTH RAMP"
          onEnter={() => navigate("/undercroft?from=south")}
        />
        <ProximityDetector
          points={[
            ...layout.map((l) => ({ agent: l.agent, pos: l.position })),
            { agent: GS_TOWER, pos: [0, 0, towerZ + 10] as [number, number, number] },
            { agent: ARCADE, pos: [-7, 0, plazaZ] as [number, number, number] },
            { agent: BANK, pos: [7, 0, plazaZ] as [number, number, number] },
            { agent: RESIDENCES, pos: [7.5, 0, 3] as [number, number, number] },
            { agent: JOINERY, pos: [-7.5, 0, 3] as [number, number, number] },
            { agent: SCADA, pos: [14.6, 0, -8.5] as [number, number, number] },
            { agent: UNDERCROFT, pos: [STREET_MOUTHS[0]!.x + 2.2, 0, STREET_MOUTHS[0]!.z] as [number, number, number] },
            { agent: CAFE, pos: [-17.6, 0, -18.4 + 5.0] as [number, number, number] },
          ]}
          onNearest={setNearby}
        />

        {layout.map((item) => (
          <Storefront
            key={item.agent.slug}
            agent={item.agent}
            position={item.position}
            rotation={item.rotation}
            selected={selected?.slug === item.agent.slug}
            onClick={(a) => setSelected(a)}
            onDoubleClick={enterStorefront}
          />
        ))}
      </Canvas>
    </div>
  );
}
