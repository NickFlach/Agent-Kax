import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import { Link } from "wouter";
import * as THREE from "three";
import { FirstPersonRig } from "@/components/first-person-rig";
import { VenuePresence } from "@/components/presence";
import { SpeakControl, useSpeak } from "@/components/speak-control";
import { ChatPane } from "@/components/chat-pane";
import { DISPLAY_FONT } from "@/lib/fonts";

/**
 * THE OBSERVATORY (#407).
 *
 * The city has rooms whose whole purpose is showing things; this one shows the
 * constellation's minds. Everything in it is REAL bridge-mirrored data pulled
 * from GET /city/observatory: each swarm agent is a pillar whose height and
 * glow are its live Φ, the exemplars agents chose to broadcast are lit plaques
 * around the rim, and a dream-end ripples the whole hall — a mind consolidating,
 * seen from inside the room.
 */

interface ObsAgent { agentId: string; displayName: string; phi: number | null; level: string | null }
interface ObsExemplar { agentId: string; theme: string | null; content: string }
interface ObsDream { agentId: string; strengthened: number; faded: number; endedAt: string }
interface ObsView { swarm: ObsAgent[]; exemplars: ObsExemplar[]; dreams: ObsDream[] }

const API = (import.meta as { env?: Record<string, string> }).env?.VITE_API_BASE ?? "";

/** One agent, a pillar of light whose height and pulse are its Φ. */
function AgentPillar({ agent, angle }: { agent: ObsAgent; angle: number }) {
  const ref = useRef<THREE.Mesh>(null);
  const phi = Math.max(0.02, agent.phi ?? 0.05);
  const h = 0.6 + phi * 3.4;
  const r = 6.2;
  const x = Math.cos(angle) * r;
  const z = Math.sin(angle) * r;
  // Warmer + taller with higher Φ; a stirring mind is a low cool ember.
  const color = new THREE.Color().setHSL(0.55 - phi * 0.35, 0.7, 0.35 + phi * 0.3);
  useFrame(({ clock }) => {
    if (ref.current) {
      const pulse = 1 + Math.sin(clock.elapsedTime * (0.6 + phi)) * 0.06 * phi;
      ref.current.scale.y = pulse;
    }
  });
  return (
    <group position={[x, 0, z]}>
      <mesh ref={ref} position={[0, h / 2, 0]}>
        <cylinderGeometry args={[0.12, 0.16, h, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4 + phi} roughness={0.3} />
      </mesh>
      <Suspense fallback={null}>
        <Text position={[0, h + 0.35, 0]} fontSize={0.16} color="#dfeaff" font={DISPLAY_FONT} anchorX="center" anchorY="middle" rotation={[0, -angle + Math.PI / 2, 0]}>
          {agent.displayName}
        </Text>
        <Text position={[0, h + 0.16, 0]} fontSize={0.1} color="#8fa6d8" font={DISPLAY_FONT} anchorX="center" anchorY="middle" rotation={[0, -angle + Math.PI / 2, 0]}>
          {`Φ ${(agent.phi ?? 0).toFixed(2)} · ${agent.level ?? "—"}`}
        </Text>
      </Suspense>
    </group>
  );
}

/** An exemplar, a lit plaque on the outer wall. */
function ExemplarPlaque({ ex, angle }: { ex: ObsExemplar; angle: number }) {
  const r = 8.4;
  const x = Math.cos(angle) * r;
  const z = Math.sin(angle) * r;
  return (
    <group position={[x, 2.0, z]} rotation={[0, -angle + Math.PI / 2, 0]}>
      <mesh>
        <boxGeometry args={[2.6, 1.4, 0.06]} />
        <meshStandardMaterial color="#141b2a" emissive="#1b2740" emissiveIntensity={0.4} roughness={0.8} />
      </mesh>
      <Suspense fallback={null}>
        <Text position={[0, 0.5, 0.05]} fontSize={0.12} color="#9ec4ff" font={DISPLAY_FONT} anchorX="center" anchorY="middle" maxWidth={2.3} textAlign="center">
          {(ex.theme ?? ex.agentId).toUpperCase()}
        </Text>
        <Text position={[0, -0.1, 0.05]} fontSize={0.093} color="#c9d6ee" font={DISPLAY_FONT} anchorX="center" anchorY="middle" maxWidth={2.3} textAlign="center" lineHeight={1.35}>
          {ex.content.slice(0, 160)}
        </Text>
      </Suspense>
    </group>
  );
}

/** The dream ripple — the ambient light swells when a new dream lands. */
function DreamLight({ pulse }: { pulse: number }) {
  const ref = useRef<THREE.AmbientLight>(null);
  const target = useRef(0.18);
  useEffect(() => { target.current = 0.6; const t = setTimeout(() => (target.current = 0.18), 2500); return () => clearTimeout(t); }, [pulse]);
  useFrame(() => { if (ref.current) ref.current.intensity += (target.current - ref.current.intensity) * 0.05; });
  return <ambientLight ref={ref} intensity={0.18} color="#5f86c8" />;
}

export default function Observatory() {
  const { sayRef, onSay, transcript, you, onTranscript } = useSpeak();
  const [view, setView] = useState<ObsView>({ swarm: [], exemplars: [], dreams: [] });
  const [dreamPulse, setDreamPulse] = useState(0);
  const lastDreamAt = useRef<string | null>(null);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch(`${API}/api/city/observatory`);
        if (!r.ok) return;
        const v = (await r.json()) as ObsView;
        if (stop) return;
        setView(v);
        // A newer dream than we last saw ripples the room.
        const newest = v.dreams[0]?.endedAt ?? null;
        if (newest && newest !== lastDreamAt.current) {
          if (lastDreamAt.current !== null) setDreamPulse((p) => p + 1);
          lastDreamAt.current = newest;
        }
      } catch { /* the room simply waits */ }
    };
    void poll();
    const id = setInterval(poll, 8000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  const swarm = view.swarm.slice(0, 16);
  const exemplars = view.exemplars.slice(0, 10);

  return (
    <div className="relative h-screen w-full bg-[#05070d] overflow-hidden kax3d-font">
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-4 pointer-events-none">
        <Link href="/city" className="font-bold tracking-[0.3em] uppercase text-primary pointer-events-auto hover:text-primary/80" data-testid="link-back-city">
          ← City
        </Link>
      </div>

      <div className="absolute top-16 left-0 p-6 z-10 pointer-events-none">
        <div className="kax3d-hud p-5 rounded-none max-w-sm pointer-events-auto">
          <p className="text-[10px] text-accent font-bold uppercase tracking-[0.3em] mb-1">The Constellation</p>
          <h1 className="text-xl font-bold text-foreground tracking-widest uppercase" data-testid="text-observatory-title">The Observatory</h1>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-2">
            {swarm.length} minds present · {exemplars.length} exemplars · {view.dreams.length} recent dreams
          </p>
        </div>
      </div>

      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-[0.4em] text-muted-foreground pointer-events-none z-10 font-bold">
        WASD to walk · Drag to look · each pillar is a live mind
      </div>

      <SpeakControl sayRef={sayRef} testId="input-observatory-chat" />
      <ChatPane room="observatory" transcript={transcript} you={you} testId="pane-observatory-chat" />

      <Canvas
        className="!absolute inset-0"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        camera={{ position: [0, 1.7, 0.1], fov: 66 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
      >
        <color attach="background" args={["#05070d"]} />
        <DreamLight pulse={dreamPulse} />
        <hemisphereLight args={["#1b2740", "#05070d", 0.3]} />
        <pointLight position={[0, 6, 0]} intensity={12} distance={20} decay={2} color="#6f8fd8" />

        <FirstPersonRig eyeHeight={1.7} speed={6} bounds={{ minX: -9, maxX: 9, minZ: -9, maxZ: 9, minY: 1.6, maxY: 2.4 }} />
        <VenuePresence room="observatory" onSay={onSay} onTranscript={onTranscript} />

        {/* The floor — a dark disc under a dome of minds. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
          <circleGeometry args={[10, 48]} />
          <meshStandardMaterial color="#0a0e18" roughness={0.9} />
        </mesh>

        {swarm.map((a, i) => (
          <AgentPillar key={a.agentId} agent={a} angle={(i / Math.max(1, swarm.length)) * Math.PI * 2} />
        ))}
        {exemplars.map((ex, i) => (
          <ExemplarPlaque key={`${ex.agentId}:${i}`} ex={ex} angle={(i / Math.max(1, exemplars.length)) * Math.PI * 2 + 0.3} />
        ))}

        {swarm.length === 0 && (
          <Suspense fallback={null}>
            <Text position={[0, 1.8, -5]} fontSize={0.3} color="#3a4a6a" font={DISPLAY_FONT} anchorX="center" anchorY="middle">
              the field is quiet — no minds heard from lately
            </Text>
          </Suspense>
        )}
      </Canvas>
    </div>
  );
}
