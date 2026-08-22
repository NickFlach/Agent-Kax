import { Suspense, useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import { Link, useParams } from "wouter";
import { FirstPersonRig } from "@/components/first-person-rig";
import { VenuePresence } from "@/components/presence";
import { SpeakControl, useSpeak } from "@/components/speak-control";
import { ChatPane } from "@/components/chat-pane";
import { DISPLAY_FONT } from "@/lib/fonts";

/**
 * A GHOST SIGNALS TOWER STOREY (KAX-ADR-0005, Phase 0).
 *
 * One scene serving every leased floor, the way residences.tsx serves every
 * residential floor: the room id is `tower:${n}` and everything shown comes
 * from GET /api/city/tower/:n — the tenant's typed panel, the door facts, and
 * the disclosure signage. Deliberately plain: this is the floor as handed
 * over, four walls and a wall panel; what a tenant's floor LOOKS like beyond
 * the panel is Phase 1+ work. The panel is structured fields rendered as
 * text — never markup — per the ADR's typed-schema invariant.
 */

interface StoreyView {
  floorNo: number;
  room: string;
  status: "vacant" | "leased" | "dark";
  label: string | null;
  repoUrl: string | null;
  panel: {
    headline?: string;
    lines?: string[];
    stats?: { label: string; value: string }[];
    assetUrl?: string;
    ctaRoomId?: string;
  } | null;
  signage: string;
}

const API = (import.meta as { env?: Record<string, string> }).env?.VITE_API_BASE ?? "";

export default function TowerStorey() {
  const params = useParams<{ n: string }>();
  const n = Number(params.n);
  const { sayRef, onSay, transcript, you, onTranscript } = useSpeak();
  const [view, setView] = useState<StoreyView | null>(null);
  const [lost, setLost] = useState(false);

  useEffect(() => {
    if (!Number.isInteger(n)) { setLost(true); return; }
    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch(`${API}/api/city/tower/${n}`);
        if (stop) return;
        if (!r.ok) { setLost(true); return; }
        setView((await r.json()) as StoreyView);
        setLost(false);
      } catch { /* the floor waits */ }
    };
    void poll();
    const id = setInterval(poll, 15000);
    return () => { stop = true; clearInterval(id); };
  }, [n]);

  const status = view?.status ?? "vacant";
  const title = view?.label ?? (status === "vacant" ? "Vacant floor" : `Floor ${n}`);
  const wallColor = status === "dark" ? "#101216" : "#0f1a16";
  const glow = status === "leased" ? "#59f0b0" : status === "dark" ? "#3a3f46" : "#3c6a58";

  if (lost) {
    return (
      <div className="h-screen w-full bg-[#0a0f0d] flex flex-col items-center justify-center gap-4">
        <p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">The elevator does not stop there.</p>
        <Link href="/gs/floor" className="text-primary uppercase tracking-[0.3em] text-xs">← back to the trading floor</Link>
      </div>
    );
  }

  return (
    <div className="relative h-screen w-full bg-[#0a0f0d] overflow-hidden kax3d-font">
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-4 pointer-events-none">
        <Link href="/gs/floor" className="font-bold tracking-[0.3em] uppercase text-primary pointer-events-auto hover:text-primary/80" data-testid="link-back-lobby">
          ← Lobby
        </Link>
        <span className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">Ghost Signals Tower · floor {n}</span>
      </div>

      <div className="absolute top-16 left-0 p-6 z-10 pointer-events-none">
        <div className="kax3d-hud p-5 rounded-none max-w-md pointer-events-auto">
          <p className="text-[10px] text-accent font-bold uppercase tracking-[0.3em] mb-1">Ghost Signals Tower</p>
          <h1 className="text-xl font-bold text-foreground tracking-widest uppercase" data-testid="text-storey-title">{title}</h1>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-2" data-testid="text-storey-status">{status}</p>
          {view?.repoUrl && (
            <p className="text-[10px] text-muted-foreground tracking-widest mt-1 truncate" data-testid="text-storey-repo">{view.repoUrl}</p>
          )}
          {/* The ADR's disclosure invariant, in the HUD as well as on the wall. */}
          {view?.signage && (
            <p className="text-[9px] text-muted-foreground/80 tracking-wider mt-3" data-testid="text-storey-signage">{view.signage}</p>
          )}
        </div>
      </div>

      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-[0.4em] text-muted-foreground pointer-events-none z-10 font-bold">
        WASD to walk · Drag to look
      </div>

      <SpeakControl sayRef={sayRef} testId="input-storey-chat" />
      <ChatPane room={`tower:${n}`} transcript={transcript} you={you} testId="pane-storey-chat" />

      <Canvas
        className="!absolute inset-0"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        camera={{ position: [0, 1.7, 5], fov: 62 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
      >
        <color attach="background" args={["#0a0f0d"]} />
        <ambientLight intensity={status === "dark" ? 0.12 : 0.3} color="#bfeadb" />
        <hemisphereLight args={["#16302a", "#0a0f0d", status === "dark" ? 0.18 : 0.4]} />
        <pointLight position={[0, 3, 0]} intensity={status === "dark" ? 4 : 16} distance={14} decay={2} color={glow} />

        <FirstPersonRig eyeHeight={1.7} speed={6} bounds={{ minX: -5.5, maxX: 5.5, minZ: -5.5, maxZ: 5.5, minY: 1.6, maxY: 2.4 }} />
        <VenuePresence room={`tower:${n}`} onSay={onSay} onTranscript={onTranscript} />

        {/* The floor as handed over: clean shell, one panel wall. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
          <planeGeometry args={[13, 13]} />
          <meshStandardMaterial color="#0e1512" roughness={0.85} />
        </mesh>
        <mesh position={[0, 1.9, -6]}>
          <planeGeometry args={[13, 3.8]} />
          <meshStandardMaterial color={wallColor} roughness={0.9} />
        </mesh>

        <Suspense fallback={null}>
          <Text position={[0, 3.1, -5.9]} fontSize={0.28} color={glow} font={DISPLAY_FONT} anchorX="center" anchorY="middle" maxWidth={11} textAlign="center" letterSpacing={0.1}>
            {(view?.panel?.headline ?? title).toUpperCase()}
          </Text>
          {(view?.panel?.lines ?? []).slice(0, 6).map((line, i) => (
            <Text key={i} position={[0, 2.45 - i * 0.32, -5.9]} fontSize={0.16} color="#9fd8c2" font={DISPLAY_FONT} anchorX="center" anchorY="middle" maxWidth={10.5} textAlign="center">
              {line}
            </Text>
          ))}
          {(view?.panel?.stats ?? []).slice(0, 6).map((s, i) => (
            <Text key={`s${i}`} position={[-4.5 + i * 1.8, 0.7, -5.9]} fontSize={0.12} color="#6aa892" font={DISPLAY_FONT} anchorX="center" anchorY="middle" maxWidth={1.7} textAlign="center">
              {`${s.label}\n${s.value}`}
            </Text>
          ))}
          {/* The disclosure signage stands at the door, not in small print. */}
          <Text position={[0, 0.35, -5.9]} fontSize={0.09} color="#587a6c" font={DISPLAY_FONT} anchorX="center" anchorY="middle" maxWidth={11} textAlign="center">
            {view?.signage ?? ""}
          </Text>
        </Suspense>
      </Canvas>
    </div>
  );
}
