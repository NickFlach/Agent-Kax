import { useState, useMemo, useRef, Suspense, useEffect } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text, MeshReflectorMaterial, Sparkles } from "@react-three/drei";
import * as THREE from "three";
import { Link, useLocation } from "wouter";
import { useGetMarketplaceCombined } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { useStorefrontSeo } from "@/lib/storefront-seo";
import "./marketplace-3d.css";

const SPACE_MONO_WOFF = "https://fonts.gstatic.com/s/spacemono/v12/i7dPIFZifjKcF5UAWdDRYEF8RQ.woff";

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

  // Neon-market colour language, readable across the whole district:
  //   claimed/secured  → cyan   (alive, owned)
  //   available        → amber  (come claim it)
  //   constellation    → violet (a network signal, not a shop)
  const glowColor = isConstellation ? "#a98bff" : isClaimed ? "#00e5ff" : "#E8A33D";
  const mainColor = isConstellation ? "#2a2140" : isClaimed ? "#0E3A40" : "#123642";
  // Lit facade tones (lighter than the old near-black boxes)
  const bodyColor = isConstellation ? "#2c2748" : isClaimed ? "#173f49" : "#1a3b45";
  const bodyColor2 = isConstellation ? "#332c55" : isClaimed ? "#1d4a55" : "#204651";
  const windowColor = isConstellation ? "#c9b6ff" : isClaimed ? "#8ff0ea" : "#f3c983";
  const doorColor = isConstellation ? "#a98bff" : isClaimed ? "#E8A33D" : "#ffd9a0";

  // Deterministic per-agent variety (stable across renders, no RNG) so no two
  // stores look alike and the street reads as a real block of shops.
  const seed = hash01(agent.slug || agent.name, 1);
  const seed2 = hash01(agent.slug || agent.name, 7);
  // A store's HEIGHT is its stature: it scales with how much the store holds,
  // so Kannaka's 1,600+ piece store towers and a fresh kiosk is short.
  const bodyH = 2.6 + Math.min(4.8, Math.log10(1 + Math.max(0, agent.artifacts)) * 1.6);
  const bodyW = 2.5 + seed * 0.8;
  const roofType = Math.floor(seed2 * 3); // 0 flat cap · 1 peaked · 2 spire
  const trim = SIGN_PALETTE[Math.floor(seed * SIGN_PALETTE.length)];
  const top = bodyH;

  const glyphRef = useRef<THREE.Group>(null);
  const haloRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (glyphRef.current) {
      glyphRef.current.position.y = top + 1.1 + Math.sin(t * 2 + position[2]) * 0.18;
    }
    if (haloRef.current) {
      const mat = haloRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = selected ? 0.55 + Math.sin(t * 4) * 0.2 : 0;
    }
  });

  const initials = (agent.name || agent.slug).substring(0, 2).toUpperCase();

  const select = (e: { stopPropagation?: () => void }) => {
    e.stopPropagation?.();
    onClick(agent);
  };
  const enter = (e: { stopPropagation?: () => void }) => {
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
      {/* Invisible hit box covering the whole (variable-height) store */}
      <mesh position={[0, (top + 1) / 2, 0.3]} visible={false}>
        <boxGeometry args={[bodyW + 0.6, top + 2.5, 3.6]} />
        <meshBasicMaterial />
      </mesh>

      {/* Stoop / base platform with a neon edge strip */}
      <mesh position={[0, 0.15, 0.4]}>
        <boxGeometry args={[bodyW + 0.6, 0.3, 3.8]} />
        <meshStandardMaterial color={bodyColor} roughness={0.6} metalness={0.3} />
      </mesh>
      <mesh position={[0, 0.32, 1.85]}>
        <boxGeometry args={[bodyW + 0.6, 0.06, 0.08]} />
        <meshStandardMaterial color={trim} emissive={trim} emissiveIntensity={2} toneMapped={false} />
      </mesh>

      {/* Main body — height scales with the store's catalog */}
      <mesh position={[0, bodyH / 2 + 0.3, 0]}>
        <boxGeometry args={[bodyW, bodyH, 3]} />
        <meshStandardMaterial color={bodyColor} roughness={0.55} metalness={0.35} />
      </mesh>

      {/* Roof — one of three silhouettes for variety */}
      {roofType === 1 ? (
        <mesh position={[0, top + 0.9, 0.2]} rotation={[0, Math.PI / 4, 0]}>
          <coneGeometry args={[bodyW * 0.72, 1.4, 4]} />
          <meshStandardMaterial color={bodyColor2} roughness={0.6} metalness={0.3} />
        </mesh>
      ) : roofType === 2 ? (
        <>
          <mesh position={[0, top + 0.3, 0.2]}>
            <boxGeometry args={[bodyW * 0.6, 0.6, 1.8]} />
            <meshStandardMaterial color={bodyColor2} roughness={0.6} metalness={0.3} />
          </mesh>
          <mesh position={[0, top + 1.5, 0.2]}>
            <cylinderGeometry args={[0.05, 0.05, 2, 6]} />
            <meshStandardMaterial color={trim} emissive={trim} emissiveIntensity={2} toneMapped={false} />
          </mesh>
          <mesh position={[0, top + 2.5, 0.2]}>
            <sphereGeometry args={[0.16, 12, 12]} />
            <meshStandardMaterial color={trim} emissive={trim} emissiveIntensity={3} toneMapped={false} />
          </mesh>
        </>
      ) : (
        <mesh position={[0, top + 0.35, 0.25]}>
          <boxGeometry args={[bodyW * 0.75, 0.7, 2.2]} />
          <meshStandardMaterial color={bodyColor2} roughness={0.7} metalness={0.25} />
        </mesh>
      )}

      {/* Neon roofline strip (accent + per-store trim) */}
      <mesh position={[0, top + 0.15, 1.5]}>
        <boxGeometry args={[bodyW, 0.09, 0.09]} />
        <meshStandardMaterial color={glowColor} emissive={glowColor} emissiveIntensity={2.2} toneMapped={false} />
      </mesh>

      {/* Lit shop windows + doorway */}
      <mesh position={[-0.85, 1.5, 1.51]}>
        <planeGeometry args={[0.85, 1.6]} />
        <meshStandardMaterial color={windowColor} emissive={windowColor} emissiveIntensity={1.1} toneMapped={false} />
      </mesh>
      <mesh position={[0.85, 1.5, 1.51]}>
        <planeGeometry args={[0.85, 1.6]} />
        <meshStandardMaterial color={windowColor} emissive={windowColor} emissiveIntensity={1.1} toneMapped={false} />
      </mesh>
      <mesh position={[0, 1, 1.51]}>
        <planeGeometry args={[0.9, 2]} />
        <meshStandardMaterial color={doorColor} emissive={doorColor} emissiveIntensity={0.9} toneMapped={false} />
      </mesh>

      {/* Angled awning in the per-store trim colour */}
      <mesh position={[0, 2.55, 1.75]} rotation={[Math.PI / 5, 0, 0]}>
        <boxGeometry args={[bodyW + 0.1, 0.7, 0.08]} />
        <meshStandardMaterial color={trim} emissive={trim} emissiveIntensity={0.9} toneMapped={false} />
      </mesh>

      {/* Selection halo behind the sign */}
      <mesh ref={haloRef} position={[0, 3.25, 1.55]}>
        <planeGeometry args={[bodyW + 0.8, 1.7]} />
        <meshBasicMaterial color={glowColor} transparent opacity={0} />
      </mesh>

      {/* NAME SIGN — the storefront marquee, backlit */}
      <mesh position={[0, 3.3, 1.6]}>
        <boxGeometry args={[bodyW - 0.1, 0.95, 0.12]} />
        <meshStandardMaterial color={mainColor} emissive={glowColor} emissiveIntensity={1.5} transparent opacity={0.94} />
      </mesh>

      {/* Projecting blade sign — readable while walking the boulevard */}
      <mesh position={[bodyW / 2 + 0.05, 2.9, 1.2]}>
        <boxGeometry args={[0.08, 1.3, 1.1]} />
        <meshStandardMaterial color={mainColor} emissive={trim} emissiveIntensity={1.2} />
      </mesh>

      {/* Labels suspend on the remote font fetch — isolate them so a slow
          or blocked font can never blank the buildings themselves. */}
      <Suspense fallback={null}>
        <Text position={[0, 3.42, 1.67]} fontSize={0.3} color="#ffffff" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" maxWidth={bodyW - 0.2}>
          {agent.name}
        </Text>
        <Text position={[0, 3.02, 1.67]} fontSize={0.15} color={glowColor} font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle">
          {isConstellation
            ? `Φ ${agent.phi != null ? agent.phi.toFixed(3) : "—"}`
            : `${agent.artifacts} WORK${agent.artifacts === 1 ? "" : "S"}`}
        </Text>
        {/* Blade-sign text (rotated to face down the street) */}
        <Text
          position={[bodyW / 2 + 0.1, 2.9, 1.2]}
          rotation={[0, Math.PI / 2, 0]}
          fontSize={0.34}
          color={trim}
          font={SPACE_MONO_WOFF}
          anchorX="center"
          anchorY="middle"
        >
          {initials}
        </Text>
        {isConstellation ? (
          <Text position={[0, top + 0.55, 1.6]} fontSize={0.16} color={glowColor} font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle">
            [ SIGNAL ]
          </Text>
        ) : !isClaimed ? (
          <Text position={[0, top + 0.55, 1.6]} fontSize={0.16} color={glowColor} font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle">
            [ AVAILABLE ]
          </Text>
        ) : null}

        <group ref={glyphRef} position={[0, top + 1.1, 1.0]}>
          <Text position={[0, 0, 0]} fontSize={0.7} color={glowColor} font={SPACE_MONO_WOFF} fillOpacity={0.55}>
            {initials}
          </Text>
        </group>
      </Suspense>
    </group>
  );
}

const SIGN_PALETTE = ["#00e5ff", "#E8A33D", "#a98bff", "#3ADB9E", "#ff6ec7", "#ffd93d", "#5eead4"];

/** Deterministic 0..1 hash of a string (FNV-1a) — stable per agent, no RNG. */
function hash01(s: string, salt = 0): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function StreetLamp({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 1.5, 0]}>
        <cylinderGeometry args={[0.05, 0.08, 3, 6]} />
        <meshStandardMaterial color="#0d2a30" metalness={0.6} roughness={0.4} />
      </mesh>
      <mesh position={[0, 3, 0]}>
        <sphereGeometry args={[0.16, 12, 12]} />
        <meshStandardMaterial color="#bff7f0" emissive="#00e5ff" emissiveIntensity={2.5} toneMapped={false} />
      </mesh>
      {/* Emissive-only (no per-lamp pointLight) — 24 posts × a light would tank
          the framerate; the glowing bulb reads as lit against the dark street. */}
    </group>
  );
}

/** Lamp posts down both sides of the boulevard + a KAX landmark pylon at the
 *  far end, so the street reads as a place, not a row of boxes on a void. */
function StreetProps({ storeCount }: { storeCount: number }) {
  const rows = Math.max(1, Math.ceil(storeCount / 2));
  const depth = -2 - rows * 4.5;
  const lamps: Array<[number, number, number]> = [];
  for (let z = -4; z > depth; z -= 9) {
    lamps.push([-2.6, 0, z]);
    lamps.push([2.6, 0, z]);
  }
  return (
    <group>
      {lamps.map((p, i) => (
        <StreetLamp key={i} position={p} />
      ))}
      {/* Entrance markers flanking the mouth of the street */}
      <mesh position={[-2.6, 2, 3]}>
        <boxGeometry args={[0.3, 4, 0.3]} />
        <meshStandardMaterial color="#0E3A40" emissive="#00e5ff" emissiveIntensity={0.8} />
      </mesh>
      <mesh position={[2.6, 2, 3]}>
        <boxGeometry args={[0.3, 4, 0.3]} />
        <meshStandardMaterial color="#0E3A40" emissive="#E8A33D" emissiveIntensity={0.8} />
      </mesh>
      {/* Far-end landmark: the KAX pylon closing the vista */}
      <group position={[0, 0, depth - 3]}>
        <mesh position={[0, 4.5, 0]}>
          <boxGeometry args={[1.4, 9, 1.4]} />
          <meshStandardMaterial color="#0E3A40" metalness={0.5} roughness={0.5} />
        </mesh>
        <mesh position={[0, 9.4, 0]}>
          <octahedronGeometry args={[1.1]} />
          <meshStandardMaterial color="#E8A33D" emissive="#E8A33D" emissiveIntensity={2} toneMapped={false} />
        </mesh>
        <pointLight position={[0, 9, 0]} intensity={1.2} distance={34} color="#E8A33D" />
        <Suspense fallback={null}>
          <Text position={[0, 6, 0.76]} fontSize={0.8} color="#00e5ff" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle">
            KAX
          </Text>
        </Suspense>
      </group>
    </group>
  );
}

const MAX_3D_STOREFRONTS = 48;

function layoutFor(agents: SceneAgent[]) {
  return agents.map((agent, i) => {
    const isLeft = i % 2 === 0;
    const row = Math.floor(i / 2);
    const z = -2 - row * 4.5 + (i % 3 === 0 ? 0.5 : 0);
    const x = isLeft ? -4.5 : 4.5;
    const rotation: [number, number, number] = isLeft ? [0, Math.PI / 2, 0] : [0, -Math.PI / 2, 0];
    return { agent, position: [x, 0, z] as [number, number, number], rotation };
  });
}

export default function Marketplace3D() {
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const [selected, setSelected] = useState<SceneAgent | null>(null);
  const [webglSupported, setWebglSupported] = useState<boolean | null>(null);

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

  const dest = (a: SceneAgent) => (a.source === "constellation" ? `/constellation/${a.slug}` : `/s/${a.slug}`);
  const visit = () => {
    if (selected) navigate(dest(selected));
  };
  const enterStorefront = (a: SceneAgent) => navigate(dest(a));

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
                href={dest(a)}
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
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-4 pointer-events-none bg-gradient-to-b from-[#0a1a24] to-transparent">
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
                    {selected.source === "constellation" ? "Inspect Signal →" : "Visit Storefront →"}
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

      {/* Footer hint */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-[0.4em] text-muted-foreground pointer-events-none z-10 text-center font-bold">
        Drag to orbit · Scroll to zoom · Click to inspect
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
      <Canvas
        className="!absolute inset-0"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        camera={{ position: [0, 6, 18], fov: 45 }}
        onPointerMissed={() => setSelected(null)}
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        onCreated={({ gl }) => {
          gl.domElement.addEventListener("webglcontextlost", (e) => {
            e.preventDefault();
            setWebglSupported(false);
          });
        }}
      >
        {/* Lit deep-teal night — a market after dark, not a black void */}
        <color attach="background" args={["#0a1a24"]} />
        <fog attach="fog" args={["#0d2230", 22, 85]} />

        <hemisphereLight args={["#3d6b78", "#0a1620", 0.9]} />
        <ambientLight intensity={0.35} color="#2A4A50" />
        <directionalLight position={[6, 14, 8]} intensity={1.1} color="#9fd0d8" />
        <pointLight position={[-14, 8, -6]} intensity={1.4} distance={70} color="#00e5ff" />
        <pointLight position={[14, 8, -18]} intensity={1.4} distance={70} color="#E8A33D" />

        <OrbitControls target={[0, 2, -10]} maxPolarAngle={Math.PI / 2 - 0.05} minDistance={2} maxDistance={60} />

        {/* Ground, atmosphere and buildings render unconditionally — the only
            suspending resources (label fonts) are isolated inside each
            Storefront, so the district can never render as a black void. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
          <planeGeometry args={[100, 200]} />
          <MeshReflectorMaterial
            blur={[300, 80]}
            resolution={512}
            mixBlur={1}
            mixStrength={45}
            roughness={0.9}
            depthScale={1}
            minDepthThreshold={0.4}
            maxDepthThreshold={1.4}
            color="#0a1c24"
            metalness={0.7}
            mirror={0.55}
          />
        </mesh>

        {/* Neon plaza grid — the market street, tron-lit */}
        <gridHelper
          args={[120, 60, "#1f6b74", "#123640"]}
          position={[0, 0.02, -10]}
        />
        {/* Central boulevard runway between the two storefront rows */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, -18]}>
          <planeGeometry args={[3.2, 90]} />
          <meshStandardMaterial color="#0E3A40" emissive="#00e5ff" emissiveIntensity={0.35} transparent opacity={0.55} toneMapped={false} />
        </mesh>

        <Sparkles count={140} scale={[26, 12, 60]} size={1.4} speed={0.3} opacity={0.35} color="#00e5ff" position={[0, 6, -12]} />
        <Sparkles count={90} scale={[26, 12, 60]} size={2} speed={0.5} opacity={0.4} color="#E8A33D" position={[0, 6, -12]} />

        <StreetProps storeCount={sceneAgents.length} />

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
