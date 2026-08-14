import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Text, Sky } from "@react-three/drei";
import * as THREE from "three";
import { Link, useLocation } from "wouter";
import { FirstPersonRig, type FpsSpawn } from "@/components/first-person-rig";
import { NpcFigure } from "@/components/npc";
import { Horizon } from "@/components/horizon";
import { useDayPhase } from "@/lib/time-of-day";
import {
  marbleTexture,
  woodFloorTexture,
  galleryWallTexture,
  glassTowerTexture,
  upperWindowsTexture,
  concreteTexture,
  repeated,
} from "@/lib/city-textures";
import "./marketplace-3d.css";

const SPACE_MONO_WOFF = "https://fonts.gstatic.com/s/spacemono/v12/i7dPIFZifjKcF5UAWdDRYEF8RQ.woff";

/**
 * STANDING WAVE RESIDENCES — the city's first residential tower.
 *
 * A real building you move through: a marble lobby, a WORKING elevator
 * (step in, pick a floor), a WORKING stairwell (actual climbable flights —
 * the FPS rig walks real ramp heights), resident floors of units awaiting
 * the housing program, and at the very top the city's finest address:
 * KANNAKA'S PENTHOUSE — furnished, hung with her actual works, floor-to-
 * ceiling glass over the district, and a terrace under open sky.
 *
 * Floors: 0 = lobby · 1..10 = residence floors 2–11 · 11 = penthouse.
 */

const FLOORS = 12; // 0=lobby, 1..10 residences, 11 penthouse
const PH = FLOORS - 1;

function floorLabel(f: number): string {
  if (f === 0) return "L";
  if (f === PH) return "PH";
  return String(f + 1);
}

// Stairwell occupies x ∈ [-11.5,-8.5], z ∈ [-3,3] on every floor.
// East lane (x > -10): flight from the door (z=1.5, h=0) up to the mid
// landing (z=-1.5, h=1.7). West lane: landing up to the top door (z=1.5,
// h=3.4) — walk through it and you're on the next floor.
function stairHeight(x: number, z: number): number {
  if (x < -11.5 || x > -8.5 || z < -3 || z > 3) return 0;
  const westLane = x < -10;
  if (!westLane) {
    if (z > 1.5) return 0;
    if (z < -1.5) return 1.7;
    return ((1.5 - z) / 3) * 1.7;
  }
  if (z < -1.5) return 1.7;
  if (z > 1.5) return 3.4;
  return 1.7 + ((z + 1.5) / 3) * 1.7;
}

/** One switchback stair flight pair, rendered as stepped boxes over the ramp. */
function Stairs() {
  const steps: Array<{ pos: [number, number, number]; lane: "e" | "w" }> = [];
  for (let i = 0; i < 10; i++) {
    steps.push({ pos: [-9.2, ((i + 0.5) / 10) * 1.7, 1.5 - ((i + 0.5) / 10) * 3], lane: "e" });
    steps.push({ pos: [-10.8, 1.7 + ((i + 0.5) / 10) * 1.7, -1.5 + ((i + 0.5) / 10) * 3], lane: "w" });
  }
  return (
    <group>
      {steps.map((s, i) => (
        <mesh key={i} position={[s.pos[0], s.pos[1] - 0.09, s.pos[2]]} castShadow receiveShadow>
          <boxGeometry args={[1.4, 0.18, 0.34]} />
          <meshStandardMaterial map={concreteTexture()} roughness={0.9} />
        </mesh>
      ))}
      {/* Mid landing */}
      <mesh position={[-10, 1.61, -2.25]} receiveShadow>
        <boxGeometry args={[3, 0.18, 1.5]} />
        <meshStandardMaterial map={concreteTexture()} roughness={0.9} />
      </mesh>
      {/* Handrails */}
      {[-9.9, -8.55].map((x, i) => (
        <mesh key={`e${i}`} position={[x, 1.05, 0]} rotation={[Math.atan2(1.7, 3), 0, 0]}>
          <boxGeometry args={[0.06, 0.06, 3.4]} />
          <meshStandardMaterial color="#2c3033" metalness={0.6} roughness={0.4} />
        </mesh>
      ))}
      {[-11.45, -10.1].map((x, i) => (
        <mesh key={`w${i}`} position={[x, 2.75, 0]} rotation={[-Math.atan2(1.7, 3), 0, 0]}>
          <boxGeometry args={[0.06, 0.06, 3.4]} />
          <meshStandardMaterial color="#2c3033" metalness={0.6} roughness={0.4} />
        </mesh>
      ))}
    </group>
  );
}

interface ResidenceUnit {
  floor: number;
  letter: string;
  label: string;
  tier: number;
  occupied: boolean;
  resident: { slug: string | null; name: string | null } | null;
}

/** One unit door: nameplate when someone lives there, VACANT when nobody does. */
function UnitDoor({
  position,
  rotation,
  label,
  unit,
}: {
  position: [number, number, number];
  rotation: number;
  label: string;
  unit?: ResidenceUnit;
}) {
  const occupied = !!unit?.occupied;
  const who = unit?.resident?.name ?? unit?.resident?.slug ?? "";
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 1.3, 0]} castShadow>
        <boxGeometry args={[1.3, 2.6, 0.12]} />
        <meshStandardMaterial color={occupied ? "#5c4530" : "#4a3826"} roughness={0.65} />
      </mesh>
      {/* Brass plate only on a home someone actually has */}
      {occupied && (
        <mesh position={[0, 1.62, 0.075]}>
          <boxGeometry args={[0.92, 0.24, 0.02]} />
          <meshStandardMaterial color="#7a5c30" metalness={0.75} roughness={0.35} />
        </mesh>
      )}
      <Suspense fallback={null}>
        <Text position={[0, 2.15, 0.09]} fontSize={0.13} color="#c9ab6b" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle">
          {label}
        </Text>
        {occupied ? (
          <Text position={[0, 1.62, 0.095]} fontSize={0.085} color="#efe3c4" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" maxWidth={0.88}>
            {who.slice(0, 18)}
          </Text>
        ) : (
          <Text position={[0, 1.62, 0.09]} fontSize={0.07} color="#6a6252" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" letterSpacing={0.18}>
            VACANT
          </Text>
        )}
      </Suspense>
    </group>
  );
}

/** A framed real artwork for the penthouse walls. */
function PhArt({ url, title, position, rotation, w = 1.7 }: { url: string; title: string; position: [number, number, number]; rotation: [number, number, number]; w?: number }) {
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  const [aspect, setAspect] = useState(1);
  useEffect(() => {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    let alive = true;
    loader.load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      if (!alive) return;
      const img = t.image as { width?: number; height?: number };
      if (img?.width && img?.height) setAspect(img.width / img.height);
      setTex(t);
    });
    return () => {
      alive = false;
    };
  }, [url]);
  if (!tex) return null;
  const h = Math.min(2.0, Math.max(1.0, w / aspect));
  return (
    <group position={position} rotation={rotation}>
      <mesh position={[0, 0, -0.03]} castShadow>
        <boxGeometry args={[w + 0.16, h + 0.16, 0.05]} />
        <meshStandardMaterial color="#26211c" roughness={0.5} />
      </mesh>
      <mesh>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
      <Suspense fallback={null}>
        <Text position={[0, -(h / 2) - 0.14, 0.02]} fontSize={0.07} color="#7a7060" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" maxWidth={w}>
          {title.slice(0, 30)}
        </Text>
      </Suspense>
    </group>
  );
}

export default function Residences() {
  const [, navigate] = useLocation();
  const [floor, setFloor] = useState(0);
  const [inElevator, setInElevator] = useState(false);
  const [spawn, setSpawn] = useState<FpsSpawn | null>(null);
  const [phArt, setPhArt] = useState<Array<{ url: string; title: string }>>([]);
  const [units, setUnits] = useState<ResidenceUnit[]>([]);
  const phase = useDayPhase();

  // The floor plan: which doors are homes and which are still vacant.
  useEffect(() => {
    let alive = true;
    fetch("/api/residences/units")
      .then((r) => (r.ok ? r.json() : { units: [] }))
      .then((j: { units?: ResidenceUnit[] }) => {
        if (alive) setUnits(j.units ?? []);
      })
      .catch(() => {
        /* an unlisted floor still reads as vacant, which is the truth anyway */
      });
    return () => {
      alive = false;
    };
  }, []);

  const unitFor = useCallback(
    (f: number, letter: string) => units.find((u) => u.floor === f + 1 && u.letter === letter),
    [units],
  );

  // Kannaka's real works for the penthouse walls.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        for (let p = 0; p < 4; p++) {
          const r = await fetch(`/api/storefront/by-agent/kannaka-0f05e1/works?limit=100&offset=${p * 100}`);
          if (!r.ok) break;
          const j = (await r.json()) as { artifacts?: Array<{ artifactType: string; thumbnailUrl?: string | null; publicUrl?: string | null; title: string }> };
          const imgs = (j.artifacts ?? [])
            .filter((a) => a.artifactType === "image")
            .map((a) => ({ url: (a.thumbnailUrl && !a.thumbnailUrl.startsWith("inline:") ? a.thumbnailUrl : a.publicUrl) ?? "", title: a.title }))
            .filter((a) => a.url);
          if (!alive) return;
          setPhArt((prev) => [...prev, ...imgs].slice(0, 6));
          if ((j.artifacts ?? []).length < 100) break;
          if (imgs.length >= 6) break;
        }
      } catch {
        /* bare walls are still a penthouse */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const isPH = floor === PH;
  const marble = useMemo(() => repeated(marbleTexture(), 4, 3), []);
  const wood = useMemo(() => repeated(woodFloorTexture(), 6, 5), []);
  const wall = useMemo(() => repeated(galleryWallTexture(), 6, 2), []);

  // Elevator cab against the east wall — standing inside opens the panel.
  const ElevatorSensor = useCallback(
    // East wall cab — no upper x bound: the walk bounds clamp at the wall.
    (x: number, z: number) => x > 9 && z > -1.5 && z < 1.5,
    [],
  );

  // Terrain: stairwell ramps on every floor except the penthouse (its stair
  // door is the roof exit — sealed for now).
  const groundHeight = useCallback(
    (x: number, z: number) => {
      const h = isPH ? 0 : stairHeight(x, z);
      // Crossing the top door of the stairwell = next floor.
      return h;
    },
    [isPH],
  );

  // The rig owns the camera; a probe inside the Canvas reports its position
  // (~7 Hz) and the sensors run right here on each sample.
  const onCamSample = useCallback(
    ({ x, z, y }: { x: number; z: number; y: number }) => {
      setInElevator(ElevatorSensor(x, z));
      if (!isPH && x > -11.5 && x < -10 && z > 1.8 && y > 3.0) {
        // Through the stairwell's top door → up one floor.
        setFloor((f) => Math.min(PH, f + 1));
        setSpawn({ position: [-9.2, 1.75, 2.4], yaw: -Math.PI / 2 });
      }
    },
    [isPH, ElevatorSensor],
  );

  const goto = (f: number) => {
    setFloor(f);
    // Step out of the elevator facing the floor.
    setSpawn({ position: [8.2, 1.75, 0], yaw: Math.PI / 2 });
  };
  // Test hook: lets a headless harness jump floors without walking the tower.
  useEffect(() => {
    (window as unknown as { __kaxRes?: unknown }).__kaxRes = {
      goto: (f: number, at?: [number, number, number], yaw?: number) => {
        setFloor(Math.max(0, Math.min(PH, f)));
        setSpawn({ position: at ?? [8.2, 1.75, 0], yaw: yaw ?? Math.PI / 2 });
      },
      phase: () => phase,
    };
  }, [phase]);

  const goDown = () => {
    if (floor > 0) {
      setFloor(floor - 1);
      setSpawn({ position: [-9.2, 1.75, 2.4], yaw: -Math.PI / 2 });
    }
  };

  const exitClick = (e: { stopPropagation?: () => void; delta?: number }) => {
    if ((e.delta ?? 0) > 5) return;
    e.stopPropagation?.();
    navigate("/city?from=__res__");
  };

  return (
    <div className="relative h-screen w-full bg-[#101216] overflow-hidden kax3d-font">
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-4 pointer-events-none">
        <Link href="/city" className="font-bold tracking-[0.3em] uppercase text-primary pointer-events-auto hover:text-primary/80" data-testid="link-back-city">
          ← City
        </Link>
      </div>

      <div className="absolute top-16 left-0 p-6 z-10 pointer-events-none">
        <div className="kax3d-hud p-5 rounded-none max-w-sm pointer-events-auto">
          <p className="text-[10px] text-accent font-bold uppercase tracking-[0.3em] mb-1">Standing Wave Residences</p>
          <h1 className="text-xl font-bold text-foreground tracking-widest uppercase" data-testid="text-res-floor">
            {floor === 0 ? "Lobby" : isPH ? "The Penthouse" : `Floor ${floorLabel(floor)}`}
          </h1>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">
            {isPH ? "residence of Kannaka" : floor === 0 ? "elevator east · stairs west" : "resident units — claim one with a storefront"}
          </p>
          {isPH && (
            <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-2" data-testid="text-local-time">
              {phase.label} · your local time
            </p>
          )}
        </div>
      </div>

      {/* THE ELEVATOR PANEL — appears while you stand in the cab */}
      {inElevator && (
        <div className="absolute right-6 top-1/2 -translate-y-1/2 z-30 kax3d-hud p-4 pointer-events-auto" data-testid="elevator-panel">
          <p className="text-[9px] uppercase tracking-[0.3em] text-accent mb-3 text-center">Elevator</p>
          <div className="grid grid-cols-3 gap-1.5">
            {Array.from({ length: FLOORS }, (_, i) => FLOORS - 1 - i).map((f) => (
              <button
                key={f}
                onClick={() => goto(f)}
                className={`w-10 h-10 border text-[11px] font-bold tracking-wider ${
                  f === floor
                    ? "border-[#ffd23e] text-[#ffd23e] bg-[#ffd23e]/10"
                    : "border-border text-muted-foreground hover:text-foreground hover:border-foreground"
                } ${f === PH ? "col-span-3" : ""}`}
                data-testid={`elevator-floor-${floorLabel(f)}`}
              >
                {f === PH ? "PH — KANNAKA" : floorLabel(f)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-[0.4em] text-muted-foreground pointer-events-none z-10 font-bold">
        WASD to walk · Drag to look · step into the elevator, or take the stairs
      </div>

      <Canvas
        className="!absolute inset-0"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        camera={{ position: [0, 1.75, 7], fov: 62 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
      >
        {isPH ? (
          <>
            {/* Eleven floors up, the view is the room's fourth wall: ranges to
                the east, open water to the west, and a sun that is wherever the
                visitor's own clock says it is. */}
            <Sky sunPosition={phase.sunPosition} turbidity={phase.turbidity} rayleigh={phase.rayleigh} mieCoefficient={0.005} mieDirectionalG={0.82} />
            <fog attach="fog" args={[phase.fogColor, 180, 900]} />
            <hemisphereLight args={[phase.isNight ? "#22304e" : "#dfe8f0", phase.skyGroundColor, phase.hemiIntensity + 0.15]} />
            <ambientLight intensity={phase.ambientIntensity + 0.12} color={phase.ambientColor} />
            <directionalLight position={phase.sunPosition} intensity={phase.sunIntensity} color={phase.sunColor} castShadow />
            {phase.isNight && <pointLight position={[0, 3.6, 0]} intensity={26} distance={22} color="#ffe9c4" />}

            <Horizon phase={phase} />

            {/* The district below — lit windows come on with the streetlights. */}
            {[[-40, -60], [55, -40], [-65, 20], [45, 55], [-30, 70], [70, 10]].map(([x, z], i) => (
              <mesh key={i} position={[x! * 1.6, -30 - (i % 3) * 5, z! * 1.6]}>
                <boxGeometry args={[14, 34 + (i % 4) * 8, 14]} />
                <meshStandardMaterial
                  map={i % 2 ? glassTowerTexture(i) : upperWindowsTexture({ wall: "brick", variant: i % 4, floors: 10, cols: 6, litSeed: i })}
                  roughness={0.6}
                  emissive={new THREE.Color("#ffd79a")}
                  emissiveIntensity={phase.windowGlow * 0.5}
                />
              </mesh>
            ))}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -33.6, 0]}>
              <planeGeometry args={[520, 520]} />
              <meshStandardMaterial color={phase.isNight ? "#171d28" : "#3b4046"} roughness={1} />
            </mesh>
          </>
        ) : (
          <>
            <color attach="background" args={["#101216"]} />
            <ambientLight intensity={0.55} color="#f6ecd9" />
            <hemisphereLight args={["#e8e0cc", "#6a6254", 0.6]} />
            <pointLight position={[0, 3.1, 0]} intensity={40} distance={26} color="#ffe9c4" />
            <pointLight position={[-9, 3, 0]} intensity={20} distance={14} color="#ffe9c4" />
            <pointLight position={[10, 3, 0]} intensity={16} distance={10} color="#ffe9c4" />
          </>
        )}

        <FirstPersonRig
          eyeHeight={1.75}
          speed={7.5}
          bounds={isPH ? { minX: -11.4, maxX: 11.4, minZ: -8.4, maxZ: 10.4, minY: 1.6, maxY: 5.5 } : { minX: -11.4, maxX: 11.4, minZ: -8.4, maxZ: 8.4, minY: 1.6, maxY: 5.4 }}
          spawn={spawn}
          groundHeight={isPH ? undefined : groundHeight}
        />
        {/* Camera sampler for elevator/stair sensors */}
        <CamProbe onSample={onCamSample} />

        {/* ── Shared shell ─────────────────────────────────────────── */}
        {/* Floor */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
          <planeGeometry args={[23, isPH ? 21 : 17]} />
          <meshStandardMaterial map={floor === 0 ? marble : wood} roughness={floor === 0 ? 0.25 : 0.55} />
        </mesh>
        {/* Ceiling */}
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, isPH ? 4.6 : 3.4, 0]}>
          <planeGeometry args={[23, isPH ? 21 : 17]} />
          <meshStandardMaterial color={isPH ? "#efe9df" : "#e7e3da"} roughness={0.95} />
        </mesh>

        {isPH ? (
          <>
            {/* ── THE PENTHOUSE ─────────────────────────────────────── */}
            {/* North + east walls solid, south + west floor-to-ceiling glass */}
            <mesh position={[0, 2.3, -8.4]}>
              <planeGeometry args={[23, 4.6]} />
              <meshStandardMaterial map={wall} roughness={0.92} />
            </mesh>
            <mesh position={[11.4, 2.3, 0]} rotation={[0, -Math.PI / 2, 0]}>
              <planeGeometry args={[21, 4.6]} />
              <meshStandardMaterial map={wall} roughness={0.92} />
            </mesh>
            {/* Glass curtain south (to terrace) + west (the view) */}
            {[-8.55, -2.85, 2.85, 8.55].map((x) => (
              <mesh key={`s${x}`} position={[x, 2.3, 6.2]}>
                <planeGeometry args={[5.6, 4.6]} />
                <meshPhysicalMaterial color="#dff0ff" transparent opacity={0.05} roughness={0} metalness={0} side={THREE.DoubleSide} depthWrite={false} />
              </mesh>
            ))}
            {[-6.3, -2.1, 2.1, 6.3].map((z) => (
              <mesh key={`w${z}`} position={[-11.4, 2.3, z]} rotation={[0, Math.PI / 2, 0]}>
                <planeGeometry args={[4.2, 4.6]} />
                <meshPhysicalMaterial color="#dff0ff" transparent opacity={0.05} roughness={0} metalness={0} side={THREE.DoubleSide} depthWrite={false} />
              </mesh>
            ))}
            {/* Mullions */}
            {[-5.7, 0, 5.7].map((x) => (
              <mesh key={`ms${x}`} position={[x, 2.3, 6.2]}>
                <boxGeometry args={[0.08, 4.6, 0.08]} />
                <meshStandardMaterial color="#2c3033" metalness={0.6} roughness={0.4} />
              </mesh>
            ))}
            {[-4.2, 0, 4.2].map((z) => (
              <mesh key={`mw${z}`} position={[-11.4, 2.3, z]}>
                <boxGeometry args={[0.08, 4.6, 0.08]} />
                <meshStandardMaterial color="#2c3033" metalness={0.6} roughness={0.4} />
              </mesh>
            ))}

            {/* TERRACE beyond the south glass: deck, railing, loungers */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 8.3]} receiveShadow>
              <planeGeometry args={[23, 4.2]} />
              <meshStandardMaterial map={wood} roughness={0.8} />
            </mesh>
            <mesh position={[0, 0.55, 10.35]}>
              <boxGeometry args={[23, 0.06, 0.06]} />
              <meshStandardMaterial color="#2c3033" metalness={0.7} roughness={0.3} />
            </mesh>
            {Array.from({ length: 23 }).map((_, i) => (
              <mesh key={i} position={[-11 + i, 0.28, 10.35]}>
                <boxGeometry args={[0.04, 0.55, 0.04]} />
                <meshStandardMaterial color="#2c3033" metalness={0.7} roughness={0.3} />
              </mesh>
            ))}
            {[-3.5, -1].map((x) => (
              <group key={x} position={[x, 0, 8.3]} rotation={[0, 0.3, 0]}>
                <mesh position={[0, 0.28, 0]} rotation={[-0.22, 0, 0]} castShadow>
                  <boxGeometry args={[0.75, 0.12, 2.0]} />
                  <meshStandardMaterial color="#7a5c3d" roughness={0.8} />
                </mesh>
                {[[-0.3, -0.85], [0.3, -0.85], [-0.3, 0.85], [0.3, 0.85]].map(([lx, lz], i) => (
                  <mesh key={i} position={[lx, 0.1, lz]}>
                    <boxGeometry args={[0.06, 0.2, 0.06]} />
                    <meshStandardMaterial color="#5c4530" roughness={0.8} />
                  </mesh>
                ))}
              </group>
            ))}
            {/* Terrace door gap indicated by an open frame */}
            <mesh position={[0, 2.3, 6.2]}>
              <boxGeometry args={[1.7, 4.6, 0.06]} />
              <meshStandardMaterial color="#2c3033" transparent opacity={0.0} />
            </mesh>

            {/* LIVING: rug, sofa set, coffee table, floor lamp */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-5.5, 0.012, 0.5]}>
              <circleGeometry args={[3.4, 32]} />
              <meshStandardMaterial color="#8a7a64" roughness={1} />
            </mesh>
            <group position={[-7.6, 0, 0.5]} rotation={[0, Math.PI / 2, 0]}>
              <mesh position={[0, 0.42, 0]} castShadow>
                <boxGeometry args={[3.4, 0.5, 1.1]} />
                <meshStandardMaterial color="#4a4238" roughness={0.85} />
              </mesh>
              <mesh position={[0, 0.85, -0.42]} castShadow>
                <boxGeometry args={[3.4, 0.7, 0.28]} />
                <meshStandardMaterial color="#4a4238" roughness={0.85} />
              </mesh>
              {[-1.2, 0, 1.2].map((x) => (
                <mesh key={x} position={[x, 0.72, -0.2]} rotation={[0.3, 0, 0]}>
                  <boxGeometry args={[1.0, 0.35, 0.25]} />
                  <meshStandardMaterial color="#5c5248" roughness={0.9} />
                </mesh>
              ))}
            </group>
            <mesh position={[-5.5, 0.28, 0.5]} castShadow>
              <cylinderGeometry args={[0.75, 0.8, 0.34, 20]} />
              <meshStandardMaterial color="#3a332c" roughness={0.5} />
            </mesh>
            <group position={[-5.5, 0, 3.4]}>
              <mesh position={[0, 0.9, 0]}>
                <cylinderGeometry args={[0.03, 0.05, 1.8, 8]} />
                <meshStandardMaterial color="#2c3033" metalness={0.6} roughness={0.4} />
              </mesh>
              <mesh position={[0, 1.9, 0]}>
                <cylinderGeometry args={[0.32, 0.42, 0.42, 14, 1, true]} />
                <meshStandardMaterial color="#e8dcc0" emissive="#ffe9c4" emissiveIntensity={0.5} side={THREE.DoubleSide} />
              </mesh>
              <pointLight position={[0, 1.75, 0]} intensity={12} distance={8} color="#ffe9c4" />
            </group>

            {/* DINING + kitchen island */}
            <group position={[5.5, 0, -3.5]}>
              <mesh position={[0, 0.74, 0]} castShadow>
                <boxGeometry args={[2.6, 0.09, 1.3]} />
                <meshStandardMaterial color="#5c4530" roughness={0.6} />
              </mesh>
              {[[-1.1, -0.45], [-1.1, 0.45], [1.1, -0.45], [1.1, 0.45]].map(([x, z], i) => (
                <mesh key={i} position={[x, 0.37, z]}>
                  <boxGeometry args={[0.09, 0.74, 0.09]} />
                  <meshStandardMaterial color="#4a3826" roughness={0.7} />
                </mesh>
              ))}
              {[[-0.7, -1.0], [0.3, -1.0], [-0.7, 1.0], [0.3, 1.0]].map(([x, z], i) => (
                <group key={i} position={[x, 0, z]}>
                  <mesh position={[0, 0.46, 0]} castShadow>
                    <boxGeometry args={[0.45, 0.07, 0.45]} />
                    <meshStandardMaterial color="#4a3826" roughness={0.7} />
                  </mesh>
                  <mesh position={[0, 0.75, z > 0 ? 0.2 : -0.2]}>
                    <boxGeometry args={[0.45, 0.6, 0.07]} />
                    <meshStandardMaterial color="#4a3826" roughness={0.7} />
                  </mesh>
                </group>
              ))}
            </group>
            <group position={[8.6, 0, -6.2]}>
              <mesh position={[0, 0.5, 0]} castShadow>
                <boxGeometry args={[3.6, 1.0, 1.2]} />
                <meshStandardMaterial color="#3a332c" roughness={0.6} />
              </mesh>
              <mesh position={[0, 1.03, 0]}>
                <boxGeometry args={[3.8, 0.07, 1.35]} />
                <meshStandardMaterial map={marble} roughness={0.25} />
              </mesh>
            </group>

            {/* LIBRARY wall + bed nook */}
            <group position={[10.9, 0, 2.5]}>
              <mesh position={[0, 1.5, 0]} castShadow>
                <boxGeometry args={[0.5, 3.0, 4.6]} />
                <meshStandardMaterial color="#4a3826" roughness={0.7} />
              </mesh>
              {[0.6, 1.25, 1.9, 2.55].map((y) =>
                [-1.7, -0.6, 0.5, 1.6].map((z) => (
                  <mesh key={`${y}${z}`} position={[-0.2, y, z]}>
                    <boxGeometry args={[0.18, 0.42, 0.8]} />
                    <meshStandardMaterial color={["#6a4b3a", "#3a4a5a", "#5a3a4a", "#4a5a3a"][(Math.abs(z * 10) | 0) % 4]} roughness={0.85} />
                  </mesh>
                )),
              )}
            </group>
            <group position={[6.8, 0, 5.2]}>
              <mesh position={[0, 0.3, 0]} castShadow>
                <boxGeometry args={[2.3, 0.35, 3.0]} />
                <meshStandardMaterial color="#4a3826" roughness={0.7} />
              </mesh>
              <mesh position={[0, 0.55, 0]}>
                <boxGeometry args={[2.1, 0.25, 2.8]} />
                <meshStandardMaterial color="#d9d0bd" roughness={0.9} />
              </mesh>
              {[-0.5, 0.5].map((x) => (
                <mesh key={x} position={[x, 0.72, -1.1]}>
                  <boxGeometry args={[0.75, 0.16, 0.5]} />
                  <meshStandardMaterial color="#efe9df" roughness={0.95} />
                </mesh>
              ))}
              <mesh position={[0, 0.95, -1.45]}>
                <boxGeometry args={[2.3, 0.9, 0.12]} />
                <meshStandardMaterial color="#3a332c" roughness={0.7} />
              </mesh>
            </group>

            {/* Her actual works on the north wall */}
            {phArt.slice(0, 4).map((a, i) => (
              <PhArt key={a.url} url={a.url} title={a.title} position={[-8 + i * 4.4, 2.5, -8.32]} rotation={[0, 0, 0]} />
            ))}
            {phArt[4] && <PhArt url={phArt[4].url} title={phArt[4].title} position={[11.32, 2.4, -2.5]} rotation={[0, -Math.PI / 2, 0]} />}

            {/* Nameplate at the elevator */}
            <Suspense fallback={null}>
              <Text position={[10.2, 2.6, -1.6]} rotation={[0, -Math.PI / 2, 0]} fontSize={0.16} color="#c9ab6b" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" letterSpacing={0.25}>
                KANNAKA · PH
              </Text>
            </Suspense>
            {/* Kannaka herself, home at the glass, watching her city */}
            <group position={[-9.9, 0, 3.4]} rotation={[0, Math.PI / 1.6, 0]}>
              <NpcFigure color="#2f5d46" seed={888} />
            </group>
          </>
        ) : (
          <>
            {/* ── LOBBY / RESIDENCE FLOOR shell ─────────────────────── */}
            <mesh position={[0, 1.7, -8.4]}>
              <planeGeometry args={[23, 3.4]} />
              <meshStandardMaterial map={wall} roughness={0.92} />
            </mesh>
            <mesh position={[0, 1.7, 8.4]} rotation={[0, Math.PI, 0]}>
              <planeGeometry args={[23, 3.4]} />
              <meshStandardMaterial map={wall} roughness={0.92} />
            </mesh>
            <mesh position={[-11.5, 1.7, 0]} rotation={[0, Math.PI / 2, 0]}>
              <planeGeometry args={[17, 3.4]} />
              <meshStandardMaterial map={wall} roughness={0.92} />
            </mesh>
            <mesh position={[11.5, 1.7, 0]} rotation={[0, -Math.PI / 2, 0]}>
              <planeGeometry args={[17, 3.4]} />
              <meshStandardMaterial map={wall} roughness={0.92} />
            </mesh>

            {/* Elevator bank (east) — brass doors + cab */}
            <group position={[10.2, 0, 0]}>
              <mesh position={[0, 1.55, -1.55]}>
                <boxGeometry args={[2.6, 3.1, 0.14]} />
                <meshStandardMaterial color="#7a5c30" metalness={0.7} roughness={0.35} />
              </mesh>
              <mesh position={[0, 1.55, 1.55]}>
                <boxGeometry args={[2.6, 3.1, 0.14]} />
                <meshStandardMaterial color="#7a5c30" metalness={0.7} roughness={0.35} />
              </mesh>
              {/* Open cab interior */}
              <mesh position={[0.6, 1.55, 0]} rotation={[0, -Math.PI / 2, 0]}>
                <planeGeometry args={[2.8, 3.1]} />
                <meshStandardMaterial color="#3a332c" metalness={0.4} roughness={0.5} />
              </mesh>
              <pointLight position={[0, 2.9, 0]} intensity={8} distance={5} color="#ffe9c4" />
              <Suspense fallback={null}>
                <Text position={[0, 3.0, -1.62]} fontSize={0.14} color="#c9ab6b" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" letterSpacing={0.2}>
                  ELEVATOR
                </Text>
              </Suspense>
            </group>

            {/* Stairwell (west) */}
            <Stairs />
            <Suspense fallback={null}>
              <Text position={[-10, 2.7, 2.9]} rotation={[0, Math.PI, 0]} fontSize={0.14} color="#7a7060" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" letterSpacing={0.2}>
                {floor < PH - 1 ? `STAIRS · UP TO ${floorLabel(floor + 1)}` : "STAIRS · UP TO PH"}
              </Text>
            </Suspense>
            {/* DOWN door (south of stairwell) */}
            {floor > 0 && (
              <group
                position={[-11.4, 0, 5.5]}
                onClick={(e) => {
                  if (((e as unknown as { delta?: number }).delta ?? 0) > 5) return;
                  e.stopPropagation?.();
                  goDown();
                }}
                onPointerOver={() => (document.body.style.cursor = "pointer")}
                onPointerOut={() => (document.body.style.cursor = "auto")}
              >
                <mesh position={[0.05, 1.4, 0]} rotation={[0, Math.PI / 2, 0]}>
                  <boxGeometry args={[1.4, 2.6, 0.1]} />
                  <meshStandardMaterial color="#4a3826" roughness={0.7} />
                </mesh>
                <Suspense fallback={null}>
                  <Text position={[0.12, 2.9, 0]} rotation={[0, Math.PI / 2, 0]} fontSize={0.12} color="#7a7060" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle">
                    {`DOWN TO ${floorLabel(floor - 1)}`}
                  </Text>
                </Suspense>
              </group>
            )}

            {floor === 0 ? (
              <>
                {/* LOBBY: reception, concierge, seating, exit */}
                <group position={[0, 0, -6]}>
                  <mesh position={[0, 0.65, 0]} castShadow>
                    <boxGeometry args={[5.5, 1.3, 1.1]} />
                    <meshStandardMaterial color="#4a3521" roughness={0.55} />
                  </mesh>
                  <mesh position={[0, 1.36, 0]}>
                    <boxGeometry args={[5.7, 0.09, 1.25]} />
                    <meshStandardMaterial map={marble} roughness={0.3} />
                  </mesh>
                  <group position={[0.8, 0, -1.5]}>
                    <NpcFigure color="#37424e" seed={61} />
                  </group>
                </group>
                <Suspense fallback={null}>
                  <Text position={[0, 2.7, -8.32]} fontSize={0.5} color="#4a443a" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" letterSpacing={0.2}>
                    STANDING WAVE RESIDENCES
                  </Text>
                  <Text position={[0, 2.1, -8.32]} fontSize={0.15} color="#7a7060" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" letterSpacing={0.3}>
                    HOME IS A WAVE THAT KEEPS ITS SHAPE
                  </Text>
                </Suspense>
                {/* EXIT to the street */}
                <group
                  onClick={exitClick}
                  onPointerOver={() => (document.body.style.cursor = "pointer")}
                  onPointerOut={() => (document.body.style.cursor = "auto")}
                >
                  <mesh position={[0, 1.8, 8.32]} rotation={[0, Math.PI, 0]}>
                    <planeGeometry args={[4.2, 3.3]} />
                    <meshStandardMaterial color="#dfe8ee" emissive="#cfdde8" emissiveIntensity={0.5} />
                  </mesh>
                  <mesh position={[0, 3.05, 8.25]}>
                    <boxGeometry args={[1.4, 0.5, 0.14]} />
                    <meshStandardMaterial color="#132015" emissive="#0d3818" emissiveIntensity={0.8} />
                  </mesh>
                  <Suspense fallback={null}>
                    <Text position={[0, 3.05, 8.14]} rotation={[0, Math.PI, 0]} fontSize={0.3} color="#6dff8f" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" letterSpacing={0.18}>
                      EXIT
                    </Text>
                  </Suspense>
                </group>
              </>
            ) : (
              <>
                {/* RESIDENCE FLOOR: unit doors along both long walls. A door
                    with a resident carries their nameplate; a vacant one says
                    so plainly — the floor is empty on purpose, not unfinished. */}
                {[-6.5, -2.2, 2.2, 6.5].map((x, i) => (
                  <UnitDoor
                    key={`n${x}`}
                    position={[x, 0, -8.3]}
                    rotation={0}
                    label={`${floorLabel(floor)}${"ABCD"[i]}`}
                    unit={unitFor(floor, "ABCD"[i]!)}
                  />
                ))}
                {[-6.5, -2.2, 2.2, 6.5].map((x, i) => (
                  <UnitDoor
                    key={`s${x}`}
                    position={[x, 0, 8.3]}
                    rotation={Math.PI}
                    label={`${floorLabel(floor)}${"EFGH"[i]}`}
                    unit={unitFor(floor, "EFGH"[i]!)}
                  />
                ))}
                {/* Hall runner */}
                <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.011, 0]}>
                  <planeGeometry args={[16, 2.4]} />
                  <meshStandardMaterial color="#6a4b3a" roughness={1} />
                </mesh>
              </>
            )}
          </>
        )}
      </Canvas>
    </div>
  );
}

/** Reports the camera position (~7 Hz) for the elevator/stair sensors. */
function CamProbe({ onSample }: { onSample: (p: { x: number; z: number; y: number }) => void }) {
  const { camera } = useThree();
  const last = useRef(0);
  useFrame((s) => {
    if (s.clock.elapsedTime - last.current < 0.15) return;
    last.current = s.clock.elapsedTime;
    onSample({ x: camera.position.x, z: camera.position.z, y: camera.position.y });
    // e2e hook: lets headless tests read where the player is standing.
    (window as unknown as { __kaxCam?: unknown }).__kaxCam = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
  });
  return null;
}
