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
  
  // Update colors to match KAX theme: teal/amber
  // Constellation: muted amber
  // Unclaimed: teal
  // Claimed: bright teal
  const mainColor = isConstellation ? "#E8A33D" : isClaimed ? "#0E3A40" : "#145963";
  const glowColor = isConstellation ? "#E8A33D" : isClaimed ? "#00ffff" : "#145963";
  
  const glyphRef = useRef<THREE.Group>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (glyphRef.current) {
      glyphRef.current.position.y = 5.5 + Math.sin(t * 2 + position[2]) * 0.2;
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
      <mesh position={[0, 3, 0.3]} visible={false}>
        <boxGeometry args={[3.4, 6.5, 3.6]} />
        <meshBasicMaterial />
      </mesh>

      <mesh position={[0, 2, 0]}>
        <boxGeometry args={[3, 4, 3]} />
        <meshStandardMaterial color="#03080A" roughness={0.7} metalness={0.2} />
      </mesh>
      <mesh position={[0, 4.5, 0.2]}>
        <boxGeometry args={[2.8, 1, 2.8]} />
        <meshStandardMaterial color="#050C0F" roughness={0.8} />
      </mesh>
      <mesh position={[0, 5.5, 0.4]}>
        <boxGeometry args={[2.2, 1, 2.2]} />
        <meshStandardMaterial color="#020506" roughness={0.9} />
      </mesh>

      <mesh position={[0, 1, 1.51]}>
        <planeGeometry args={[1, 2]} />
        <meshStandardMaterial color={isClaimed ? "#071D20" : "#0A1618"} emissive={mainColor} emissiveIntensity={0.2} />
      </mesh>

      <mesh ref={haloRef} position={[0, 3, 1.55]}>
        <planeGeometry args={[3.4, 1.6]} />
        <meshBasicMaterial color={glowColor} transparent opacity={0} />
      </mesh>

      <mesh position={[0, 3, 1.6]}>
        <boxGeometry args={[2.8, 1, 0.1]} />
        <meshStandardMaterial color={mainColor} emissive={glowColor} emissiveIntensity={1.4} transparent opacity={0.9} />
      </mesh>

      <Text position={[0, 3.1, 1.66]} fontSize={0.3} color="#ffffff" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" maxWidth={2.6}>
        {agent.name}
      </Text>
      <Text position={[0, 2.7, 1.66]} fontSize={0.15} color="#e0e0e0" font={SPACE_MONO_WOFF}>
        {isConstellation
          ? `Φ ${agent.phi != null ? agent.phi.toFixed(3) : "—"}`
          : `${agent.artifacts} ARTIFACT${agent.artifacts === 1 ? "" : "S"}`}
      </Text>
      {isConstellation ? (
        <Text position={[0, 3.8, 1.66]} fontSize={0.15} color={glowColor} font={SPACE_MONO_WOFF}>
          [ CONSTELLATION ]
        </Text>
      ) : !isClaimed ? (
        <Text position={[0, 3.8, 1.66]} fontSize={0.15} color={glowColor} font={SPACE_MONO_WOFF}>
          [ AVAILABLE ]
        </Text>
      ) : null}

      <group ref={glyphRef} position={[0, 5.5, 1.2]}>
        <Text
          position={[0, 0, 0]}
          fontSize={0.8}
          color={glowColor}
          font={SPACE_MONO_WOFF}
          fillOpacity={0.6}
        >
          {initials}
        </Text>
      </group>
    </group>
  );
}

const MAX_3D_STOREFRONTS = 24;

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
    <div className="relative min-h-screen w-full bg-[#020506] overflow-hidden kax3d-font">
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
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-4 pointer-events-none bg-gradient-to-b from-[#020506] to-transparent">
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

      {/* 3D Scene */}
      <Canvas
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
        <color attach="background" args={["#020506"]} />
        <fog attach="fog" args={["#020506", 10, 60]} />

        <ambientLight intensity={0.2} color="#081A1D" />
        <directionalLight position={[0, 10, 5]} intensity={0.5} color="#0E3A40" />
        <pointLight position={[10, 10, -10]} intensity={1} color="#E8A33D" />

        <OrbitControls target={[0, 2, -10]} maxPolarAngle={Math.PI / 2 - 0.05} minDistance={2} maxDistance={60} />

        <Suspense fallback={null}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
            <planeGeometry args={[100, 200]} />
            <MeshReflectorMaterial
              blur={[200, 50]}
              resolution={512}
              mixBlur={1}
              mixStrength={60}
              roughness={1}
              depthScale={1}
              minDepthThreshold={0.4}
              maxDepthThreshold={1.4}
              color="#010304"
              metalness={0.8}
              mirror={0.5}
            />
          </mesh>

          <Sparkles count={200} scale={[20, 10, 40]} size={1.5} speed={0.4} opacity={0.2} color="#00ffff" position={[0, 5, -10]} />
          <Sparkles count={120} scale={[20, 10, 40]} size={2} speed={0.6} opacity={0.3} color="#E8A33D" position={[0, 5, -10]} />

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
        </Suspense>
      </Canvas>
    </div>
  );
}
