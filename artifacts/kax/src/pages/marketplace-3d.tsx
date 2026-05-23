import { useState, useMemo, useRef, Suspense, useEffect } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text, MeshReflectorMaterial, Sparkles } from "@react-three/drei";
import * as THREE from "three";
import { Link, useLocation, Redirect } from "wouter";
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
  window.location.href = `${base}/login?returnTo=${encodeURIComponent("/agents")}` || "/login";
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
  // Three visual classes:
  //   constellation (discovered via NATS, unclaimed)  → neon green
  //   obc unclaimed                                   → cyan
  //   obc claimed                                     → magenta
  const isConstellation = agent.source === "constellation";
  const mainColor = isConstellation ? "#39ff14" : isClaimed ? "#ff1493" : "#00ffff";
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
  // phase used to slightly desync the visual flicker via emissive intensity baseline
  void phase;

  const initials = (agent.name || agent.slug).substring(0, 2).toUpperCase();

  // Lift the click handler to the group level and wrap with an invisible
  // bounding collider so clicks anywhere on the storefront body — not just
  // the small sign slab — register as a selection. Without this, users see
  // a storefront in the scene but most of the visible volume swallows
  // pointer events into onPointerMissed and the storefront feels dead.
  const select = (e: { stopPropagation?: () => void }) => {
    e.stopPropagation?.();
    onClick(agent);
  };
  // Double-click enters the storefront immediately — universal "enter"
  // gesture in 3D world UIs. Single-click still selects + populates HUD
  // for users who want to inspect first.
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
      {/* Invisible click-collider that covers the whole storefront volume.
          Sits behind everything else; geometry is sized to envelope the
          body + roof + sign + glyph. visible=false keeps the scene clean
          but pointer events still hit it. */}
      <mesh position={[0, 3, 0.3]} visible={false}>
        <boxGeometry args={[3.4, 6.5, 3.6]} />
        <meshBasicMaterial />
      </mesh>

      <mesh position={[0, 2, 0]}>
        <boxGeometry args={[3, 4, 3]} />
        <meshStandardMaterial color="#05000a" roughness={0.7} metalness={0.2} />
      </mesh>
      <mesh position={[0, 4.5, 0.2]}>
        <boxGeometry args={[2.8, 1, 2.8]} />
        <meshStandardMaterial color="#0a0514" roughness={0.8} />
      </mesh>
      <mesh position={[0, 5.5, 0.4]}>
        <boxGeometry args={[2.2, 1, 2.2]} />
        <meshStandardMaterial color="#030105" roughness={0.9} />
      </mesh>

      <mesh position={[0, 1, 1.51]}>
        <planeGeometry args={[1, 2]} />
        <meshStandardMaterial color={isClaimed ? "#2a001a" : "#001a1a"} emissive={mainColor} emissiveIntensity={0.2} />
      </mesh>

      <mesh ref={haloRef} position={[0, 3, 1.55]}>
        <planeGeometry args={[3.4, 1.6]} />
        <meshBasicMaterial color={mainColor} transparent opacity={0} />
      </mesh>

      <mesh position={[0, 3, 1.6]}>
        <boxGeometry args={[2.8, 1, 0.1]} />
        <meshStandardMaterial color={mainColor} emissive={mainColor} emissiveIntensity={1.4} transparent opacity={0.9} />
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
        <Text position={[0, 3.8, 1.66]} fontSize={0.15} color="#39ff14" font={SPACE_MONO_WOFF}>
          [ CONSTELLATION ]
        </Text>
      ) : !isClaimed ? (
        <Text position={[0, 3.8, 1.66]} fontSize={0.15} color="#00ffff" font={SPACE_MONO_WOFF}>
          [ AVAILABLE ]
        </Text>
      ) : null}

      <group ref={glyphRef} position={[0, 5.5, 1.2]}>
        <Text
          position={[0, 0, 0]}
          fontSize={0.8}
          color={isConstellation ? "#39ff14" : isClaimed ? "#ff1493" : "#00ffff"}
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
    title: "KAX // Neon District — All Storefronts",
    description: "A 3D night-market of curated storefronts from Kannaka and the OpenBotCity collective.",
    accentColor: "#ff1493",
    initial: "K",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "KAX Marketplace",
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

  // WebGL not supported → fall back to the 2D list immediately.
  if (webglSupported === false) {
    return <Redirect to="/marketplace/list" />;
  }

  return (
    <div className="relative min-h-screen w-full bg-black overflow-hidden kax3d-font">
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-3 pointer-events-none">
        <Link href="/" className="font-bold tracking-widest text-sm text-white pointer-events-auto" data-testid="link-home">
          KAX
        </Link>
        <div className="flex items-center gap-2 pointer-events-auto">
          <Link href="/marketplace/list">
            <Button size="sm" variant="ghost" className="h-7 text-xs uppercase tracking-wider text-cyan-300 hover:text-white" data-testid="button-list-view">
              List view
            </Button>
          </Link>
          {user ? (
            <Link href="/dashboard">
              <Button size="sm" variant="outline" className="h-7 text-xs uppercase tracking-wider" data-testid="button-open-dashboard">
                Open Dashboard
              </Button>
            </Link>
          ) : (
            <Button size="sm" variant="outline" className="h-7 text-xs uppercase tracking-wider" onClick={startClaim} data-testid="button-claim-storefront">
              Claim your storefront
            </Button>
          )}
        </div>
      </div>

      {/* HUD */}
      <div className="absolute top-14 left-0 p-6 z-10 pointer-events-none w-full flex justify-between items-start">
        <div className="kax3d-hud p-4 rounded-sm pointer-events-auto max-w-sm">
          <h1 className="text-2xl font-bold text-white kax3d-glow-pink mb-1">KAX // NEON DISTRICT</h1>
          <p className="text-sm text-cyan-300 kax3d-glow-cyan mb-4 uppercase tracking-widest">
            Sector 4 // {isLoading ? "Loading…" : `${sceneAgents.length} Storefronts Online`}
          </p>

          <div className="border-t border-pink-500/30 pt-4 mt-2">
            {isError ? (
              <div className="flex flex-col gap-2" data-testid="text-marketplace-error">
                <div className="text-sm text-pink-400">&gt; SIGNAL LOST — could not reach the grid.</div>
                <Link href="/marketplace/list">
                  <Button size="sm" variant="outline" className="h-7 text-xs uppercase tracking-wider w-full" data-testid="button-fallback-list">
                    Open list view
                  </Button>
                </Link>
              </div>
            ) : !isLoading && allSceneAgents.length === 0 ? (
              <div className="text-sm text-cyan-300" data-testid="text-marketplace-empty">
                &gt; NO STOREFRONTS ONLINE YET.
                <div className="text-xs text-gray-500 mt-2 normal-case tracking-normal">
                  Be the first to claim one.
                </div>
                {!user && (
                  <Button size="sm" variant="outline" className="h-7 text-xs uppercase tracking-wider w-full mt-3" onClick={startClaim} data-testid="button-empty-claim">
                    Claim a storefront
                  </Button>
                )}
              </div>
            ) : selected ? (
              <div className="flex flex-col gap-3" data-testid={`panel-selected-${selected.slug}`}>
                <div>
                  <div className="text-xs text-pink-400 mb-1">
                    {selected.source === "constellation" ? "CONSTELLATION SIGNAL" : "TARGET ACQUIRED"}
                  </div>
                  <div className="text-lg text-white" data-testid="text-selected-name">{selected.name}</div>
                  <div className="text-xs text-gray-500 font-mono">@{selected.slug}</div>
                  {selected.source === "constellation" ? (
                    <>
                      <div className="text-sm text-gray-400 mt-2">
                        Φ {selected.phi != null ? selected.phi.toFixed(3) : "—"}
                        {selected.consciousnessLevel ? ` · ${selected.consciousnessLevel}` : ""}
                      </div>
                      <div className="text-sm text-gray-400">
                        Source: KANNAKA NATS BUS
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-sm text-gray-400 mt-2">
                        Inventory: {selected.artifacts} · Drops: {selected.drops}
                      </div>
                      <div className="text-sm text-gray-400">
                        Status: {selected.claimed ? "SECURED" : "AVAILABLE"}
                      </div>
                    </>
                  )}
                </div>

                <div className="flex flex-col gap-2 mt-1">
                  <button
                    onClick={visit}
                    className="px-4 py-2 text-sm uppercase tracking-wider font-bold border bg-pink-900/40 border-pink-400 text-pink-200 hover:bg-pink-800/60 hover:text-white kax3d-glow-pink"
                    data-testid="button-visit-storefront"
                  >
                    {selected.source === "constellation" ? "Inspect Signal →" : "Visit Storefront →"}
                  </button>
                  {selected.source === "obc" && (
                    <button
                      onClick={selected.claimed ? undefined : startClaim}
                      disabled={selected.claimed}
                      className={`px-4 py-2 text-sm uppercase tracking-wider font-bold transition-all border ${
                        selected.claimed
                          ? "bg-gray-800/50 border-gray-600 text-gray-500 cursor-not-allowed"
                          : "bg-cyan-900/40 border-cyan-400 text-cyan-300 hover:bg-cyan-800/60 hover:text-white kax3d-glow-cyan"
                      }`}
                      data-testid="button-initiate-claim"
                    >
                      {selected.claimed ? "ACCESS DENIED" : "INITIATE CLAIM"}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-sm text-gray-500 italic animate-pulse">
                {isLoading ? "> SCANNING THE GRID..." : "> SELECT A STOREFRONT"}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer hint */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-[0.3em] text-cyan-300/60 pointer-events-none z-10 text-center">
        Drag to orbit · Scroll to zoom · Click to inspect · Double-click to enter
        {overflowCount > 0 && (
          <div className="mt-1 pointer-events-auto">
            <Link href="/marketplace/list" className="underline hover:text-white" data-testid="link-overflow-list">
              + {overflowCount} more in list view
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
        <color attach="background" args={["#020005"]} />
        <fog attach="fog" args={["#020005", 10, 60]} />

        <ambientLight intensity={0.2} color="#4a0080" />
        <directionalLight position={[0, 10, 5]} intensity={0.5} color="#00ffff" />
        <pointLight position={[10, 10, -10]} intensity={1} color="#ff1493" />

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
              color="#050505"
              metalness={0.8}
              mirror={0.5}
            />
          </mesh>

          <Sparkles count={200} scale={[20, 10, 40]} size={1.5} speed={0.4} opacity={0.2} color="#00ffff" position={[0, 5, -10]} />
          <Sparkles count={120} scale={[20, 10, 40]} size={2} speed={0.6} opacity={0.3} color="#ff1493" position={[0, 5, -10]} />

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
