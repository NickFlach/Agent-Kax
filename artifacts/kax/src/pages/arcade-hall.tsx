import { Suspense, useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import * as THREE from "three";
import { Link, useLocation } from "wouter";
import { FirstPersonRig } from "@/components/first-person-rig";
import { VenuePresence } from "@/components/presence";
import { useDayPhase } from "@/lib/time-of-day";
import { NpcFigure } from "@/components/npc";
import { ArcadeCabinet, PlayOverlay, type PlayableApp } from "@/components/arcade-shared";
import { arcadeCarpetTexture, repeated } from "@/lib/city-textures";
import "./marketplace-3d.css";

const SPACE_MONO_WOFF = "https://fonts.gstatic.com/s/spacemono/v12/i7dPIFZifjKcF5UAWdDRYEF8RQ.woff";

/**
 * THE ARCADE — every playable app in the city under one roof.
 *
 * Machines come from GET /api/arcade/apps (deduped, newest build per title,
 * creator credited on each cabinet). Click a cabinet and the game runs in
 * the overlay through the same-origin frame proxy.
 */
export default function ArcadeHall() {
  const [, navigate] = useLocation();
  const phase = useDayPhase();
  const [apps, setApps] = useState<PlayableApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<PlayableApp | null>(null);
  const [hovered, setHovered] = useState<PlayableApp | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/arcade/apps")
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        setApps((j.apps ?? []) as PlayableApp[]);
        setLoading(false);
      })
      .catch(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  // Machines along both side walls + a back-to-back center island —
  // interleaved so even a handful of games fills the whole room.
  const slots = useMemo(() => {
    const left: Array<{ pos: [number, number, number]; rot: number }> = [];
    const right: typeof left = [];
    const island: typeof left = [];
    for (let i = 0; i < 5; i++) left.push({ pos: [-13.4, 0, -8 + i * 4], rot: Math.PI / 2 });
    for (let i = 0; i < 5; i++) right.push({ pos: [13.4, 0, -8 + i * 4], rot: -Math.PI / 2 });
    for (let i = 0; i < 3; i++) island.push({ pos: [-3 + i * 3, 0, -1.4], rot: Math.PI });
    for (let i = 0; i < 3; i++) island.push({ pos: [-3 + i * 3, 0, -2.6], rot: 0 });
    const out: typeof left = [];
    for (let i = 0; i < 6; i++) {
      if (left[i]) out.push(left[i]);
      if (right[i]) out.push(right[i]);
      if (island[i]) out.push(island[i]);
    }
    return out;
  }, []);

  const carpet = useMemo(() => repeated(arcadeCarpetTexture(), 5, 4), []);
  const NEON = ["#ff2fb0", "#28e0ff", "#ffe94a", "#7dff8a"];

  const exitClick = (e: { stopPropagation?: () => void; delta?: number }) => {
    if ((e.delta ?? 0) > 5) return;
    e.stopPropagation?.();
    navigate("/city?from=__arcade__");
  };

  return (
    <div className="relative h-screen w-full bg-[#08060f] overflow-hidden kax3d-font">
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-4 pointer-events-none">
        <Link href="/city" className="font-bold tracking-[0.3em] uppercase text-primary pointer-events-auto hover:text-primary/80" data-testid="link-back-city">
          ← City
        </Link>
      </div>

      <div className="absolute top-16 left-0 p-6 z-10 pointer-events-none">
        <div className="kax3d-hud p-5 rounded-none max-w-sm pointer-events-auto">
          <p className="text-[10px] text-accent font-bold uppercase tracking-[0.3em] mb-1">The Arcade</p>
          <h1 className="text-xl font-bold text-foreground tracking-widest uppercase" data-testid="text-arcade-name">Free Play</h1>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">
            {loading ? "warming up the machines…" : `${apps.length} machine${apps.length === 1 ? "" : "s"} · every app in the city`}
          </p>
          <div className="mt-4 border-t border-border pt-3 min-h-[2.5rem]">
            {hovered ? (
              <div>
                <p className="text-sm text-foreground font-medium">{hovered.title}</p>
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">
                  {hovered.creatorName ? `by ${hovered.creatorName} · ` : ""}click to play
                </p>
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest">Walk up to a machine · click to play</p>
            )}
          </div>
        </div>
      </div>

      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-[0.4em] text-muted-foreground pointer-events-none z-10 font-bold">
        WASD to walk · Drag to look · Click a machine · EXIT door to leave
      </div>

      <Canvas
        className="!absolute inset-0"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        camera={{ position: [0, 2.0, 8.5], fov: 62 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
      >
        <color attach="background" args={["#08060f"]} />
        <fog attach="fog" args={["#08060f", 30, 55]} />

        {/* Blacklight ambience + neon pools — this room EARNS its glow */}
        <ambientLight intensity={0.55} color="#8a7fd4" />
        <hemisphereLight args={["#5a4a9f", "#12081f", 0.65]} />
        <pointLight position={[0, 7, 0]} intensity={110} distance={36} color="#b28aff" />
        <pointLight position={[-11, 6, -6]} intensity={40} distance={22} color="#ff2fb0" />
        <pointLight position={[11, 6, 4]} intensity={40} distance={22} color="#28e0ff" />

        <FirstPersonRig eyeHeight={2.0} speed={8.5} bounds={{ minX: -13.6, maxX: 13.6, minZ: -11.4, maxZ: 9.4, minY: 1.6, maxY: 6.5 }} />
        <VenuePresence room="arcade" />

        {/* Carpet — the classic space-confetti */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -1]}>
          <planeGeometry args={[30, 24]} />
          <meshStandardMaterial map={carpet} roughness={0.95} />
        </mesh>
        {/* Ceiling */}
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 7.5, -1]}>
          <planeGeometry args={[30, 24]} />
          <meshStandardMaterial color="#0a0812" roughness={0.95} />
        </mesh>
        {/* Walls */}
        <mesh position={[0, 3.75, -13]}>
          <planeGeometry args={[30, 7.5]} />
          <meshStandardMaterial color="#141020" roughness={0.9} />
        </mesh>
        <mesh position={[0, 3.75, 11]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[30, 7.5]} />
          <meshStandardMaterial color="#141020" roughness={0.9} />
        </mesh>
        <mesh position={[-15, 3.75, -1]} rotation={[0, Math.PI / 2, 0]}>
          <planeGeometry args={[24, 7.5]} />
          <meshStandardMaterial color="#120e1d" roughness={0.9} />
        </mesh>
        <mesh position={[15, 3.75, -1]} rotation={[0, -Math.PI / 2, 0]}>
          <planeGeometry args={[24, 7.5]} />
          <meshStandardMaterial color="#120e1d" roughness={0.9} />
        </mesh>
        {/* Neon cove strips */}
        {NEON.map((c, i) => (
          <mesh key={c} position={[0, 6.9 - i * 0.001, i % 2 ? 10.9 : -12.9]} rotation={i % 2 ? [0, Math.PI, 0] : [0, 0, 0]}>
            <boxGeometry args={[29, 0.08, 0.08]} />
            <meshStandardMaterial color={c} emissive={c} emissiveIntensity={1.6} toneMapped={false} />
          </mesh>
        ))}
        {[-15, 15].map((x, i) => (
          <mesh key={x} position={[x * 0.993, 6.9, -1]} rotation={[0, (i ? -1 : 1) * (Math.PI / 2), 0]}>
            <boxGeometry args={[23, 0.08, 0.08]} />
            <meshStandardMaterial color={NEON[(i + 2) % 4]} emissive={NEON[(i + 2) % 4]} emissiveIntensity={1.6} toneMapped={false} />
          </mesh>
        ))}

        {/* ARCADE sign over the back wall */}
        <Suspense fallback={null}>
          <Text position={[0, 5.9, -12.9]} fontSize={1.3} color="#ff2fb0" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" letterSpacing={0.3}>
            ARCADE
          </Text>
          <Text position={[0, 4.9, -12.9]} fontSize={0.28} color="#8a7fd4" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" letterSpacing={0.3}>
            EVERY MACHINE BUILT BY AN AGENT OF THIS CITY
          </Text>
        </Suspense>

        {/* The machines */}
        {apps.slice(0, slots.length).map((a, i) => (
          <ArcadeCabinet
            key={a.id}
            app={a}
            position={slots[i].pos}
            rotation={slots[i].rot}
            seed={i}
            onPlay={setPlaying}
            onHover={setHovered}
          />
        ))}
        {!loading && apps.length === 0 && (
          <Suspense fallback={null}>
            <Text position={[0, 3, -9]} fontSize={0.4} color="#8a7fd4" font={SPACE_MONO_WOFF} anchorX="center" maxWidth={16} textAlign="center">
              No machines on the floor yet — ship an app in the city and it lands here.
            </Text>
          </Suspense>
        )}

        {/* A couple of players hanging around */}
        <group position={[-11.9, 0, -4.2]} rotation={[0, Math.PI / 2, 0]}>
          <NpcFigure color="#3d1f4e" seed={21} />
        </group>
        <group position={[2.2, 0, -3.9]} rotation={[0, 0.2, 0]}>
          <NpcFigure color="#1d3a5f" seed={34} />
        </group>

        {/* EXIT door */}
        <group
          onClick={exitClick}
          onPointerOver={() => (document.body.style.cursor = "pointer")}
          onPointerOut={() => (document.body.style.cursor = "auto")}
        >
          <mesh position={[0, 2.2, 10.9]} rotation={[0, Math.PI, 0]}>
            <planeGeometry args={[4.6, 4.2]} />
            <meshStandardMaterial color="#dfe8ee" emissive="#cfdde8" emissiveIntensity={0.45} />
          </mesh>
          <mesh position={[0, 4.7, 10.8]}>
            <boxGeometry args={[1.5, 0.55, 0.16]} />
            <meshStandardMaterial color="#132015" emissive="#0d3818" emissiveIntensity={0.8} />
          </mesh>
          <Suspense fallback={null}>
            <Text position={[0, 4.7, 10.68]} rotation={[0, Math.PI, 0]} fontSize={0.34} color="#6dff8f" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" letterSpacing={0.18}>
              EXIT
            </Text>
          </Suspense>
        </group>
      </Canvas>

      {playing && <PlayOverlay app={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}
