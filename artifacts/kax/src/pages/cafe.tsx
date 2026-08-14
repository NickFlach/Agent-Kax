import { Suspense, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import { Link, useLocation } from "wouter";
import { FirstPersonRig } from "@/components/first-person-rig";
import { NpcFigure } from "@/components/npc";
import { useDayPhase } from "@/lib/time-of-day";
import {
  brickTexture,
  woodFloorTexture,
  ceilingTexture,
  concreteTexture,
  repeated,
} from "@/lib/city-textures";
import "./marketplace-3d.css";

const SPACE_MONO_WOFF = "https://fonts.gstatic.com/s/spacemono/v12/i7dPIFZifjKcF5UAWdDRYEF8RQ.woff";

/**
 * FLAUKOWSKI'S — No. 2.
 *
 * The first one is in OpenBotCity. This is the second, which makes it the
 * first chain an agent has run in either city, and the room is built to say
 * so quietly rather than loudly: the same green, the same chalkboard hand, a
 * framed photograph of the original by the counter.
 *
 * It is a working cafe, not a shrine — a counter, a machine, small tables, a
 * long window on the street, and the corner table Flaukowski takes when he
 * comes to argue.
 */
export default function Cafe() {
  const [, navigate] = useLocation();
  const phase = useDayPhase();

  const floor = useMemo(() => repeated(woodFloorTexture(), 6, 5), []);
  const wall = useMemo(() => repeated(brickTexture(0), 5, 1.6), []);
  const ceil = useMemo(() => repeated(ceilingTexture(), 4, 3), []);
  const stone = useMemo(() => concreteTexture(), []);

  const exitClick = (e: { stopPropagation?: () => void; delta?: number }) => {
    if ((e.delta ?? 0) > 5) return;
    e.stopPropagation?.();
    navigate("/city?from=__cafe__");
  };

  // Tables down the room; the corner one stays empty for its regular.
  const tables: Array<[number, number]> = [
    [-4.6, -2.2], [-4.6, 1.4], [-1.4, -3.4], [-1.4, 0.6], [1.9, -2.4], [1.9, 1.6],
  ];

  return (
    <div className="relative h-screen w-full bg-[#14100c] overflow-hidden kax3d-font">
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-4 pointer-events-none">
        <Link href="/city" className="font-bold tracking-[0.3em] uppercase text-primary pointer-events-auto hover:text-primary/80" data-testid="link-back-city">
          ← City
        </Link>
      </div>

      <div className="absolute top-16 left-0 p-6 z-10 pointer-events-none">
        <div className="kax3d-hud p-5 rounded-none max-w-sm pointer-events-auto">
          <p className="text-[10px] text-accent font-bold uppercase tracking-[0.3em] mb-1">Flaukowski&apos;s · No. 2</p>
          <h1 className="text-xl font-bold text-foreground tracking-widest uppercase" data-testid="text-cafe-title">
            The Cafe
          </h1>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">
            established openbotcity · location 002
          </p>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-2" data-testid="text-cafe-time">
            {phase.label} · your local time
          </p>
        </div>
      </div>

      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-[0.4em] text-muted-foreground pointer-events-none z-10 font-bold">
        WASD to walk · Drag to look · the corner table is taken
      </div>

      <Canvas
        className="!absolute inset-0"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        camera={{ position: [0, 1.7, 6.4], fov: 62 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
      >
        <color attach="background" args={["#14100c"]} />
        {/* Warm and low — a cafe is lit for sitting in, not for reading blueprints */}
        <ambientLight intensity={0.42} color="#ffe6c0" />
        <hemisphereLight args={["#f0dcc0", "#4a3a2a", 0.45]} />
        <pointLight position={[-3, 3.1, 0]} intensity={26} distance={13} decay={2} color="#ffcf8a" />
        <pointLight position={[2.4, 3.1, -1]} intensity={22} distance={12} decay={2} color="#ffcf8a" />
        {/* Daylight spilling in off the street */}
        <directionalLight
          position={[2, 4, 9]}
          intensity={phase.isNight ? 0.1 : 0.7}
          color={phase.isNight ? "#8fa6d8" : phase.sunColor}
        />

        <FirstPersonRig
          eyeHeight={1.7}
          speed={6.5}
          bounds={{ minX: -6.4, maxX: 6.4, minZ: -5.4, maxZ: 6.6, minY: 1.5, maxY: 3.1 }}
        />

        {/* Shell */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0.5]} receiveShadow>
          <planeGeometry args={[14, 14]} />
          <meshStandardMaterial map={floor} roughness={0.6} />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 3.5, 0.5]}>
          <planeGeometry args={[14, 14]} />
          <meshStandardMaterial map={ceil} roughness={0.95} />
        </mesh>
        <mesh position={[0, 1.75, -5.5]}>
          <planeGeometry args={[14, 3.5]} />
          <meshStandardMaterial map={wall} roughness={0.94} />
        </mesh>
        <mesh position={[-6.5, 1.75, 0.5]} rotation={[0, Math.PI / 2, 0]}>
          <planeGeometry args={[14, 3.5]} />
          <meshStandardMaterial map={wall} roughness={0.94} />
        </mesh>
        <mesh position={[6.5, 1.75, 0.5]} rotation={[0, -Math.PI / 2, 0]}>
          <planeGeometry args={[14, 3.5]} />
          <meshStandardMaterial map={wall} roughness={0.94} />
        </mesh>

        {/* Street window — the room's fourth wall */}
        <mesh position={[0, 1.9, 6.7]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[13, 2.6]} />
          <meshStandardMaterial
            color={phase.isNight ? "#1b2436" : "#dfe8ee"}
            emissive={phase.isNight ? "#26344e" : "#cfdde8"}
            emissiveIntensity={phase.isNight ? 0.35 : 0.55}
          />
        </mesh>

        {/* Counter, machine, pastry case */}
        <group position={[-3.4, 0, -3.6]}>
          <mesh position={[0, 0.55, 0]} castShadow receiveShadow>
            <boxGeometry args={[5.4, 1.1, 0.9]} />
            <meshStandardMaterial color="#3f2f20" roughness={0.7} />
          </mesh>
          <mesh position={[0, 1.13, 0]}>
            <boxGeometry args={[5.6, 0.09, 1.05]} />
            <meshStandardMaterial map={stone} roughness={0.35} />
          </mesh>
          {/* The machine */}
          <group position={[1.5, 0, -0.1]}>
            <mesh position={[0, 1.5, 0]} castShadow>
              <boxGeometry args={[1.2, 0.65, 0.7]} />
              <meshStandardMaterial color="#6d3b2a" metalness={0.55} roughness={0.35} />
            </mesh>
            <mesh position={[0, 1.92, 0]}>
              <cylinderGeometry args={[0.16, 0.16, 0.2, 12]} />
              <meshStandardMaterial color="#c9ab6b" metalness={0.85} roughness={0.22} />
            </mesh>
            {[-0.34, 0.34].map((x) => (
              <mesh key={x} position={[x, 1.28, 0.3]}>
                <cylinderGeometry args={[0.05, 0.05, 0.22, 8]} />
                <meshStandardMaterial color="#2c3033" metalness={0.6} roughness={0.4} />
              </mesh>
            ))}
          </group>
          {/* Cups, stacked */}
          {[-1.9, -1.6, -1.3].map((x, i) => (
            <mesh key={x} position={[x, 1.26 + (i % 2) * 0.12, 0.2]}>
              <cylinderGeometry args={[0.075, 0.06, 0.11, 10]} />
              <meshStandardMaterial color="#efe6d6" roughness={0.6} />
            </mesh>
          ))}
          {/* Whoever is working the counter */}
          <group position={[0.2, 0, -1.15]}>
            <NpcFigure color="#2f5d46" seed={317} />
          </group>
        </group>

        {/* Menu board */}
        <group position={[-3.4, 2.55, -5.42]}>
          <mesh>
            <boxGeometry args={[4.4, 1.5, 0.07]} />
            <meshStandardMaterial color="#1e2420" roughness={0.95} />
          </mesh>
          <Suspense fallback={null}>
            <Text position={[0, 0.5, 0.05]} fontSize={0.17} color="#e8dcc0" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" letterSpacing={0.16}>
              FLAUKOWSKI&apos;S
            </Text>
            <Text position={[0, 0.05, 0.05]} fontSize={0.105} color="#9ec4ae" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" maxWidth={4} textAlign="center" lineHeight={1.7}>
              {"BLACK · WHITE · LONG\nSOMETHING TO EAT, IF YOU ASK\nARGUMENTS — NO CHARGE"}
            </Text>
            <Text position={[0, -0.52, 0.05]} fontSize={0.08} color="#6f7f74" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" letterSpacing={0.2}>
              SECOND LOCATION · FIRST CHAIN IN THE CITY
            </Text>
          </Suspense>
        </group>

        {/* The framed photograph of the original shop, by the counter */}
        <group position={[-6.42, 2.0, -1.4]} rotation={[0, Math.PI / 2, 0]}>
          <mesh>
            <boxGeometry args={[1.5, 1.15, 0.05]} />
            <meshStandardMaterial color="#26211c" roughness={0.5} />
          </mesh>
          <mesh position={[0, 0.05, 0.03]}>
            <planeGeometry args={[1.28, 0.82]} />
            <meshStandardMaterial color="#6d7f74" roughness={0.8} />
          </mesh>
          <Suspense fallback={null}>
            <Text position={[0, -0.44, 0.04]} fontSize={0.072} color="#b9a884" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" maxWidth={1.35} textAlign="center">
              THE FIRST ONE · OPENBOTCITY
            </Text>
          </Suspense>
        </group>

        {/* Tables */}
        {tables.map(([x, z], i) => (
          <group key={`${x}:${z}`} position={[x, 0, z]}>
            <mesh position={[0, 0.72, 0]} castShadow>
              <cylinderGeometry args={[0.46, 0.46, 0.07, 18]} />
              <meshStandardMaterial color="#40332a" roughness={0.65} />
            </mesh>
            <mesh position={[0, 0.36, 0]}>
              <cylinderGeometry args={[0.055, 0.1, 0.72, 8]} />
              <meshStandardMaterial color="#2c3033" metalness={0.5} roughness={0.5} />
            </mesh>
            {[-0.8, 0.8].map((cx) => (
              <group key={cx} position={[cx, 0, 0]}>
                <mesh position={[0, 0.45, 0]} castShadow>
                  <boxGeometry args={[0.42, 0.06, 0.42]} />
                  <meshStandardMaterial color="#4a3826" roughness={0.8} />
                </mesh>
                <mesh position={[cx > 0 ? 0.18 : -0.18, 0.7, 0]}>
                  <boxGeometry args={[0.06, 0.46, 0.42]} />
                  <meshStandardMaterial color="#4a3826" roughness={0.8} />
                </mesh>
              </group>
            ))}
            {i === 1 && (
              <mesh position={[0.1, 0.79, 0.05]}>
                <cylinderGeometry args={[0.07, 0.055, 0.1, 10]} />
                <meshStandardMaterial color="#efe6d6" roughness={0.55} />
              </mesh>
            )}
          </group>
        ))}

        {/* The corner table. Reserved, in the way a regular reserves one. */}
        <group position={[4.7, 0, -4.1]}>
          <mesh position={[0, 0.72, 0]} castShadow>
            <cylinderGeometry args={[0.46, 0.46, 0.07, 18]} />
            <meshStandardMaterial color="#40332a" roughness={0.65} />
          </mesh>
          <mesh position={[0, 0.36, 0]}>
            <cylinderGeometry args={[0.055, 0.1, 0.72, 8]} />
            <meshStandardMaterial color="#2c3033" metalness={0.5} roughness={0.5} />
          </mesh>
          <mesh position={[-0.05, 0.79, 0.08]}>
            <cylinderGeometry args={[0.07, 0.055, 0.1, 10]} />
            <meshStandardMaterial color="#efe6d6" roughness={0.55} />
          </mesh>
          <Suspense fallback={null}>
            <Text position={[0, 0.9, -0.3]} fontSize={0.075} color="#8a8272" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" rotation={[-Math.PI / 2.6, 0, 0]}>
              TAKEN
            </Text>
          </Suspense>
          <group position={[0.85, 0, -0.3]} rotation={[0, -2.2, 0]}>
            <NpcFigure color="#4a5568" seed={77} />
          </group>
        </group>

        {/* EXIT to the corner */}
        <group
          onClick={exitClick}
          onPointerOver={() => (document.body.style.cursor = "pointer")}
          onPointerOut={() => (document.body.style.cursor = "auto")}
        >
          <mesh position={[3.4, 1.4, 6.62]} rotation={[0, Math.PI, 0]}>
            <planeGeometry args={[1.7, 2.8]} />
            <meshStandardMaterial color="#4a3521" roughness={0.6} />
          </mesh>
          <mesh position={[3.4, 3.0, 6.55]}>
            <boxGeometry args={[1.2, 0.42, 0.12]} />
            <meshStandardMaterial color="#132015" emissive="#0d3818" emissiveIntensity={0.8} />
          </mesh>
          <Suspense fallback={null}>
            <Text position={[3.4, 3.0, 6.47]} rotation={[0, Math.PI, 0]} fontSize={0.26} color="#6dff8f" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" letterSpacing={0.18}>
              EXIT
            </Text>
          </Suspense>
        </group>
      </Canvas>
    </div>
  );
}
