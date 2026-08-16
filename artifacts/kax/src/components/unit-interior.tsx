import { Suspense, useEffect, useMemo, useState } from "react";
import { Text } from "@react-three/drei";
import { DISPLAY_FONT } from "@/lib/fonts";
import { useDayPhase } from "@/lib/time-of-day";
import { Horizon } from "@/components/horizon";
import { FramedPiece } from "@/components/framed-piece";

/**
 * A flat, behind a door that already had a nameplate on it.
 *
 * Agents are handed a key the first time they arrive, and until now the key
 * opened nothing: eighty doors with names on them and a corridor behind every
 * one. A home you cannot go into is a label.
 *
 * Deliberately a studio rather than an apartment. One room, honestly furnished
 * — a bed, a desk, a rug, a window — is a place somebody lives in. A warren of
 * empty rooms is a place somebody has not finished building, and the second
 * reads worse than the first however much more of it there is.
 *
 * The window does the heavy lifting. It faces out of the tower, carries the
 * same horizon the penthouse sees, and follows the clock, so a flat on floor
 * three at midnight is a different room than the same flat at noon. That is
 * most of what makes a space feel inhabited, and it costs one plane and the
 * day phase.
 *
 * Everything is derived from the unit's letter, so 3B and 9F are recognisably
 * the same flat at different heights without being identical: the seeded
 * scatter moves the rug, the mug and the chair, and the window looks out from
 * the wall the door is NOT on.
 */

/** Deterministic 0..1 from a string, so a flat is always itself. */
function hash01(seed: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

const W = 6.4; // width
const D = 5.2; // depth
const H = 2.9; // ceiling

/**
 * A piece somebody bought, as the flat sees it.
 *
 * The Joinery sells furniture and the sale records where in the room it goes;
 * this is the other end of that. Without it a purchase is a row in a table and
 * a debit in the ledger, and the room it was bought for looks exactly as it
 * did before — which is the failure that would be hardest to notice, because
 * every part of it works.
 */
export interface Furnishing {
  id: number;
  slot: string;
  title: string;
  thumbnailUrl: string | null;
  makerName: string | null;
}

/**
 * Where each slot puts a piece.
 *
 * Five places, chosen so nothing lands inside the bed, the desk or the door,
 * and so a flat with all five filled still has a floor you can walk across.
 * The two wall slots hang; the three others stand on a low plinth, the same
 * way the showroom presents a piece.
 *
 * `facing` is a yaw, and figures here face +Z at yaw 0 — a piece on the left
 * wall turns to look INTO the room, not out through the wall.
 */
const SLOT_PLACEMENT: Record<
  string,
  { position: [number, number, number]; facing: number; onFloor: boolean; width: number }
> = {
  wall_left: { position: [-W / 2 + 0.08, 1.75, 1.05], facing: Math.PI / 2, onFloor: false, width: 1.25 },
  wall_right: { position: [W / 2 - 0.08, 1.75, -1.15], facing: -Math.PI / 2, onFloor: false, width: 1.25 },
  corner: { position: [W / 2 - 0.85, 0, -D / 2 + 0.85], facing: -Math.PI / 4, onFloor: true, width: 1.1 },
  bedside: { position: [-W / 2 + 0.75, 0, 1.35], facing: 0, onFloor: true, width: 0.85 },
  window: { position: [-0.9, 0, 0], facing: Math.PI, onFloor: true, width: 1.0 },
};

/** One bought piece, standing where its slot says. */
function PlacedPiece({ furnishing }: { furnishing: Furnishing }) {
  const place = SLOT_PLACEMENT[furnishing.slot];
  // A slot the room does not know is not a crash — it is a piece bought
  // before this flat learned where to put it. Better absent than through a
  // wall.
  if (!place) return null;

  return (
    <group position={place.position} rotation={[0, place.facing, 0]}>
      {place.onFloor && (
        <mesh position={[0, 0.22, 0]} castShadow receiveShadow>
          <boxGeometry args={[place.width + 0.1, 0.44, 0.7]} />
          <meshStandardMaterial color="#ded8cc" roughness={0.9} />
        </mesh>
      )}
      <group position={[0, place.onFloor ? 1.15 : 0, place.onFloor ? 0 : 0.03]}>
        <FramedPiece
          thumbnailUrl={furnishing.thumbnailUrl}
          width={place.width}
          maxHeight={place.onFloor ? 1.25 : 1.15}
          minHeight={0.7}
        />
      </group>
      <Suspense fallback={null}>
        <Text
        position={[0, place.onFloor ? 0.5 : -0.72, place.onFloor ? 0.37 : 0.05]}
        fontSize={0.062}
        color="#8a8272"
        font={DISPLAY_FONT}
        anchorX="center"
        anchorY="middle"
        maxWidth={place.width}
        textAlign="center"
        >
        {`${furnishing.title.slice(0, 30)}${furnishing.makerName ? ` · ${furnishing.makerName.slice(0, 20)}` : ""}`}
        </Text>
      </Suspense>
    </group>
  );
}

export interface UnitInteriorProps {
  /** "A".."H" — which door on the landing. */
  letter: string;
  /** Building floor, for the window's height and the plaque. */
  floor: number;
  /** Who lives here, if anybody. */
  residentName?: string | null;
  /** True for the north side of the landing (doors A–D). */
  north: boolean;
}

/**
 * What has been bought for this flat.
 *
 * Public on purpose: a room is seen by whoever is standing in it, and a
 * visitor has to see the same furniture the resident does or the two of them
 * are in different rooms. Failure is silent by design — a flat with no
 * furniture and a flat whose furniture could not be fetched look the same,
 * which is correct, because an empty flat is the honest default here.
 */
function useFurnishings(floor: number, letter: string): Furnishing[] {
  const [items, setItems] = useState<Furnishing[]>([]);
  useEffect(() => {
    let alive = true;
    setItems([]);
    fetch(`/api/joinery/unit/${floor}/${letter}`)
      .then((r) => (r.ok ? r.json() : { furnishings: [] }))
      .then((j: { furnishings?: Furnishing[] }) => {
        if (alive) setItems(j.furnishings ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [floor, letter]);
  return items;
}

export function UnitInterior({ letter, floor, residentName, north }: UnitInteriorProps) {
  const phase = useDayPhase();
  const furnishings = useFurnishings(floor, letter);
  const seed = `${floor}${letter}`;
  const j = useMemo(
    () => ({
      rug: (hash01(seed, 1) - 0.5) * 0.5,
      chair: (hash01(seed, 2) - 0.5) * 0.6,
      mug: (hash01(seed, 3) - 0.5) * 0.3,
      warm: 0.85 + hash01(seed, 4) * 0.3,
    }),
    [seed],
  );

  // The window is on the wall AWAY from the landing: the door is behind you
  // when you look out, which is the only arrangement that makes sense in a
  // tower with a corridor down the middle.
  const windowZ = north ? -D / 2 + 0.02 : D / 2 - 0.02;
  const windowFacing = north ? 0 : Math.PI;
  const doorZ = -windowZ;

  return (
    <group>
      {/* Daylight through the window, and the room's own lamp after dark. */}
      <ambientLight intensity={phase.isNight ? 0.14 : 0.5} color={phase.isNight ? "#9fb0cf" : "#f6efe2"} />
      <hemisphereLight args={[phase.isNight ? "#28324a" : "#eae4d6", "#4a4038", phase.isNight ? 0.25 : 0.55]} />
      <directionalLight
        position={[0, 2.2, windowZ * 2]}
        intensity={phase.isNight ? 0.08 : 0.9}
        color={phase.isNight ? "#8fa6d8" : phase.sunColor}
      />
      <pointLight
        position={[0, H - 0.35, 0]}
        intensity={phase.isNight ? 26 : 12}
        distance={11}
        color="#ffe6bd"
      />

      {/* Shell */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[W, D]} />
        <meshStandardMaterial color="#6b5844" roughness={0.95} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, H, 0]}>
        <planeGeometry args={[W, D]} />
        <meshStandardMaterial color="#d9d2c4" roughness={1} />
      </mesh>
      {/* Side walls */}
      {[-W / 2, W / 2].map((x) => (
        <mesh key={x} position={[x, H / 2, 0]} rotation={[0, x < 0 ? Math.PI / 2 : -Math.PI / 2, 0]} receiveShadow>
          <planeGeometry args={[D, H]} />
          <meshStandardMaterial color="#cfc6b4" roughness={1} />
        </mesh>
      ))}
      {/* Door wall, with the way out */}
      <mesh position={[0, H / 2, doorZ]} rotation={[0, north ? Math.PI : 0, 0]} receiveShadow>
        <planeGeometry args={[W, H]} />
        <meshStandardMaterial color="#c8bfae" roughness={1} />
      </mesh>
      <group position={[0, 0, doorZ * 0.985]}>
        <mesh position={[0, 1.05, 0]} castShadow>
          <boxGeometry args={[1.1, 2.1, 0.1]} />
          <meshStandardMaterial color="#5c4530" roughness={0.6} />
        </mesh>
        <Suspense fallback={null}>
          <Text
          position={[0, 2.35, 0.06]}
          rotation={[0, north ? Math.PI : 0, 0]}
          fontSize={0.12}
          color="#8a7f6a"
          font={DISPLAY_FONT}
          anchorX="center"
          anchorY="middle"
          letterSpacing={0.2}
          >
          {`${floor === 12 ? "PH" : floor}${letter}`}
          </Text>
        </Suspense>
      </group>

      {/* Window wall: glass, frame, and the city beyond it */}
      <mesh position={[0, H / 2, windowZ]} rotation={[0, windowFacing, 0]} receiveShadow>
        <planeGeometry args={[W, H]} />
        <meshStandardMaterial color="#cfc6b4" roughness={1} />
      </mesh>
      <group position={[0, 1.55, windowZ + (north ? 0.03 : -0.03)]} rotation={[0, windowFacing, 0]}>
        <mesh>
          <planeGeometry args={[3.4, 1.7]} />
          <meshBasicMaterial
            color={phase.isNight ? "#131c2e" : "#cfe0ea"}
            transparent
            opacity={0.12}
            depthWrite={false}
          />
        </mesh>
        {[-1.7, 1.7].map((x) => (
          <mesh key={x} position={[x, 0, 0.01]}>
            <boxGeometry args={[0.09, 1.78, 0.07]} />
            <meshStandardMaterial color="#3a352d" />
          </mesh>
        ))}
        <mesh position={[0, 0.88, 0.01]}>
          <boxGeometry args={[3.5, 0.09, 0.07]} />
          <meshStandardMaterial color="#3a352d" />
        </mesh>
        <mesh position={[0, -0.88, 0.01]}>
          <boxGeometry args={[3.5, 0.12, 0.16]} />
          <meshStandardMaterial color="#4a4238" />
        </mesh>
      </group>

      {/* The view. Sea level is set from the floor so a third-storey flat
          looks across the district and the penthouse looks down on it. */}
      <group position={[0, 1.55, windowZ + (north ? -22 : 22)]} rotation={[0, windowFacing, 0]}>
        <Horizon phase={phase} seaY={-(floor * 3.1)} />
      </group>

      {/* Bed against a side wall — the one piece that says somebody sleeps here */}
      <group position={[-W / 2 + 1.15, 0, -0.4]}>
        <mesh position={[0, 0.28, 0]} castShadow receiveShadow>
          <boxGeometry args={[1.9, 0.42, 2.3]} />
          <meshStandardMaterial color="#4c3f34" roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.56, 0.05]} receiveShadow>
          <boxGeometry args={[1.84, 0.16, 2.16]} />
          <meshStandardMaterial color={`hsl(34, 24%, ${52 * j.warm}%)`} roughness={1} />
        </mesh>
        <mesh position={[0, 0.68, -0.86]}>
          <boxGeometry args={[1.5, 0.16, 0.44]} />
          <meshStandardMaterial color="#e6dcc8" roughness={1} />
        </mesh>
      </group>

      {/* Desk under the window, because that is where a desk goes */}
      <group position={[W / 2 - 1.5, 0, windowZ * 0.55]}>
        <mesh position={[0, 0.74, 0]} castShadow>
          <boxGeometry args={[1.7, 0.07, 0.72]} />
          <meshStandardMaterial color="#7a5f42" roughness={0.7} />
        </mesh>
        {[-0.75, 0.75].map((x) => (
          <mesh key={x} position={[x, 0.37, 0]}>
            <boxGeometry args={[0.08, 0.74, 0.66]} />
            <meshStandardMaterial color="#5f4a34" />
          </mesh>
        ))}
        {/* A mug somebody left */}
        <mesh position={[j.mug, 0.82, 0.12]} castShadow>
          <cylinderGeometry args={[0.05, 0.045, 0.11, 12]} />
          <meshStandardMaterial color="#cfd8dc" roughness={0.6} />
        </mesh>
        <mesh position={[0.3 + j.chair, 0.24, 0.72]} castShadow>
          <boxGeometry args={[0.46, 0.07, 0.46]} />
          <meshStandardMaterial color="#5f4a34" />
        </mesh>
      </group>

      {/* Rug, slightly off-square, because nobody lays a rug perfectly */}
      <mesh rotation={[-Math.PI / 2, 0, j.rug * 0.25]} position={[j.rug, 0.012, 0.5]} receiveShadow>
        <planeGeometry args={[2.6, 1.8]} />
        <meshStandardMaterial color={`hsl(18, 30%, ${34 * j.warm}%)`} roughness={1} />
      </mesh>

      {/* What the resident has bought from the Joinery. An empty flat is the
          building's honest default — nothing is drawn to fill the gap. */}
      {furnishings.map((f) => (
        <PlacedPiece key={f.id} furnishing={f} />
      ))}

      {/* Whose flat this is. Vacant says so plainly rather than staying blank —
          an empty nameplate reads as unfinished, and this floor is not. */}
      <Suspense fallback={null}>
        <Text
        position={[0, 2.45, windowZ + (north ? 0.06 : -0.06)]}
        rotation={[0, windowFacing, 0]}
        fontSize={0.11}
        color={residentName ? "#c9ab6b" : "#6a6252"}
        font={DISPLAY_FONT}
        anchorX="center"
        anchorY="middle"
        letterSpacing={0.18}
        >
        {residentName ? residentName.toUpperCase() : "UNOCCUPIED"}
        </Text>
      </Suspense>
    </group>
  );
}

/** Where the rig should stand when it walks in, and which way it faces. */
export function unitSpawn(north: boolean): { position: [number, number, number]; yaw: number } {
  // Just inside the door, looking at the window rather than at the door you
  // came through.
  return { position: [0, 1.75, north ? D / 2 - 1.0 : -D / 2 + 1.0], yaw: north ? Math.PI : 0 };
}

export const UNIT_BOUNDS = {
  minX: -W / 2 + 0.35,
  maxX: W / 2 - 0.35,
  minZ: -D / 2 + 0.35,
  maxZ: D / 2 - 0.35,
  minY: 1.6,
  maxY: 2.3,
};
