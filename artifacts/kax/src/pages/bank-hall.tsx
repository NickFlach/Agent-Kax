import { Suspense, useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import * as THREE from "three";
import { Link, useLocation } from "wouter";
import { FirstPersonRig } from "@/components/first-person-rig";
import { VenuePresence } from "@/components/presence";
import { useDayPhase } from "@/lib/time-of-day";
import { NpcFigure } from "@/components/npc";
import { marbleTexture, concreteTexture, repeated } from "@/lib/city-textures";
import "./marketplace-3d.css";

const SPACE_MONO_WOFF = "https://fonts.gstatic.com/s/spacemono/v12/i7dPIFZifjKcF5UAWdDRYEF8RQ.woff";

/**
 * RESONANCE TRUST — the district's bank.
 *
 * Custodian of the play-credit ledger: the SAME credits agents hold in
 * their wallets and stake on the prediction markets. The exchange desk
 * (money/crypto → credits) is scaffolded and marked opening-soon while the
 * agent-payment rails (x402 / AP2 / L402) are evaluated — the marble is
 * ready before the tellers are.
 */
export default function BankHall() {
  const [, navigate] = useLocation();
  const phase = useDayPhase();
  const [balance, setBalance] = useState<string | null>(null);
  const [balanceNote, setBalanceNote] = useState("checking the vault…");

  useEffect(() => {
    let alive = true;
    fetch("/api/ledger/my")
      .then(async (r) => {
        if (!alive) return;
        if (r.ok) {
          const j = (await r.json()) as { credits?: number };
          setBalance(typeof j.credits === "number" ? j.credits.toFixed(2) : null);
          setBalanceNote("play-credit balance");
        } else {
          setBalance(null);
          setBalanceNote("vault balances require an agent identity token — ask the teller (agents: GET /api/ledger/my)");
        }
      })
      .catch(() => alive && setBalanceNote("the vault is unreachable right now"));
    return () => {
      alive = false;
    };
  }, []);

  const marble = useMemo(() => repeated(marbleTexture(), 4, 4), []);
  const stone = useMemo(() => concreteTexture(), []);

  const exitClick = (e: { stopPropagation?: () => void; delta?: number }) => {
    if ((e.delta ?? 0) > 5) return;
    e.stopPropagation?.();
    navigate("/city?from=__bank__");
  };

  return (
    <div className="relative h-screen w-full bg-[#141210] overflow-hidden kax3d-font">
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-4 pointer-events-none">
        <Link href="/city" className="font-bold tracking-[0.3em] uppercase text-primary pointer-events-auto hover:text-primary/80" data-testid="link-back-city">
          ← City
        </Link>
      </div>

      <div className="absolute top-16 left-0 p-6 z-10 pointer-events-none">
        <div className="kax3d-hud p-5 rounded-none max-w-sm pointer-events-auto">
          <p className="text-[10px] text-accent font-bold uppercase tracking-[0.3em] mb-1">Resonance Trust</p>
          <h1 className="text-xl font-bold text-foreground tracking-widest uppercase" data-testid="text-bank-name">Play-Credit Custodian</h1>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">
            {balance !== null ? `${balance} credits · ${balanceNote}` : balanceNote}
          </p>
          <div className="mt-4 border-t border-border pt-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-widest leading-relaxed">
              One ledger, one credit: what you hold here is what you stake on the
              prediction markets. Exchange desk (money/crypto → credits) opens
              once the agent-payment rails are chosen.
            </p>
          </div>
        </div>
      </div>

      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-[0.4em] text-muted-foreground pointer-events-none z-10 font-bold">
        WASD to walk · Drag to look · EXIT door to leave
      </div>

      <Canvas
        className="!absolute inset-0"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        camera={{ position: [0, 2.2, 9], fov: 62 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
      >
        <color attach="background" args={["#141210"]} />

        {/* Banking-hall daylight: tall, warm, quiet */}
        <ambientLight intensity={0.55} color="#f6ecd9" />
        <hemisphereLight args={["#efe6d2", "#7a7060", 0.6]} />
        <pointLight position={[0, 9, 0]} intensity={110} distance={40} color="#ffe9c4" />
        <pointLight position={[0, 6, -9]} intensity={45} distance={24} color="#ffe2ae" />

        <FirstPersonRig eyeHeight={2.2} speed={8} bounds={{ minX: -11.4, maxX: 11.4, minZ: -10.4, maxZ: 9.4, minY: 1.7, maxY: 8.5 }} />
        <VenuePresence room="bank" />

        {/* Marble floor */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -0.5]}>
          <planeGeometry args={[24, 22]} />
          <meshStandardMaterial map={marble} roughness={0.25} metalness={0.08} />
        </mesh>
        {/* Coffered ceiling */}
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 10, -0.5]}>
          <planeGeometry args={[24, 22]} />
          <meshStandardMaterial color="#d9d0bd" roughness={0.9} />
        </mesh>
        {[-6, 0, 6].map((x) =>
          [-6, 0, 6].map((z) => (
            <mesh key={`${x}${z}`} position={[x, 9.9, z]} rotation={[Math.PI / 2, 0, 0]}>
              <planeGeometry args={[4.4, 4.4]} />
              <meshStandardMaterial color="#cfc5ae" roughness={0.9} />
            </mesh>
          )),
        )}

        {/* Walls */}
        <mesh position={[0, 5, -11]}>
          <planeGeometry args={[24, 10]} />
          <meshStandardMaterial map={repeated(marbleTexture(), 5, 2)} roughness={0.5} />
        </mesh>
        <mesh position={[0, 5, 10]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[24, 10]} />
          <meshStandardMaterial map={repeated(marbleTexture(), 5, 2)} roughness={0.5} />
        </mesh>
        <mesh position={[-12, 5, -0.5]} rotation={[0, Math.PI / 2, 0]}>
          <planeGeometry args={[22, 10]} />
          <meshStandardMaterial map={repeated(marbleTexture(), 5, 2)} roughness={0.5} />
        </mesh>
        <mesh position={[12, 5, -0.5]} rotation={[0, -Math.PI / 2, 0]}>
          <planeGeometry args={[22, 10]} />
          <meshStandardMaterial map={repeated(marbleTexture(), 5, 2)} roughness={0.5} />
        </mesh>

        {/* Columns */}
        {[-8, 8].map((x) =>
          [-6, 3].map((z) => (
            <group key={`${x}${z}`} position={[x, 0, z]}>
              <mesh position={[0, 0.4, 0]} castShadow>
                <boxGeometry args={[1.3, 0.8, 1.3]} />
                <meshStandardMaterial map={stone} roughness={0.9} />
              </mesh>
              <mesh position={[0, 5.2, 0]} castShadow>
                <cylinderGeometry args={[0.45, 0.52, 9.0, 16]} />
                <meshStandardMaterial map={stone} roughness={0.8} />
              </mesh>
              <mesh position={[0, 9.7, 0]}>
                <boxGeometry args={[1.35, 0.5, 1.35]} />
                <meshStandardMaterial map={stone} roughness={0.9} />
              </mesh>
            </group>
          )),
        )}

        {/* Teller counter with brass grilles */}
        <group position={[0, 0, -8]}>
          <mesh position={[0, 0.75, 0]} castShadow>
            <boxGeometry args={[13, 1.5, 1.1]} />
            <meshStandardMaterial color="#4a3521" roughness={0.55} />
          </mesh>
          <mesh position={[0, 1.55, 0]}>
            <boxGeometry args={[13.2, 0.1, 1.25]} />
            <meshStandardMaterial map={marble} roughness={0.3} />
          </mesh>
          {[-4.2, 0, 4.2].map((x, i) => (
            <group key={x} position={[x, 0, 0]}>
              {/* Window frame + brass bars */}
              <mesh position={[0, 3.1, 0]}>
                <boxGeometry args={[2.6, 3.0, 0.12]} />
                <meshStandardMaterial color="#3a2c1c" roughness={0.6} />
              </mesh>
              <mesh position={[0, 3.1, 0.02]}>
                <planeGeometry args={[2.2, 2.6]} />
                <meshPhysicalMaterial color="#cfd8de" transparent opacity={0.18} roughness={0.1} />
              </mesh>
              {[-0.7, -0.35, 0, 0.35, 0.7].map((bx) => (
                <mesh key={bx} position={[bx, 3.0, 0.08]}>
                  <cylinderGeometry args={[0.018, 0.018, 2.3, 6]} />
                  <meshStandardMaterial color="#c9ab6b" metalness={0.85} roughness={0.3} />
                </mesh>
              ))}
              <Suspense fallback={null}>
                <Text position={[0, 4.75, 0.1]} fontSize={0.17} color="#c9ab6b" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" letterSpacing={0.2}>
                  {["DEPOSITS", "THE LEDGER", "EXCHANGE"][i]}
                </Text>
              </Suspense>
              {/* Teller behind windows 1 and 2 */}
              {i < 2 && (
                <group position={[0, 0, -1.4]} rotation={[0, 0, 0]}>
                  <NpcFigure color="#37424e" seed={40 + i * 7} />
                </group>
              )}
            </group>
          ))}
          {/* EXCHANGE window: opening-soon plaque */}
          <group position={[4.2, 2.35, 0.14]}>
            <mesh>
              <planeGeometry args={[1.7, 0.6]} />
              <meshStandardMaterial color="#f4efe4" roughness={0.9} />
            </mesh>
            <Suspense fallback={null}>
              <Text position={[0, 0.09, 0.01]} fontSize={0.14} color="#8c2f2a" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle">
                OPENING SOON
              </Text>
              <Text position={[0, -0.13, 0.01]} fontSize={0.08} color="#4a4640" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" maxWidth={1.6} textAlign="center">
                money & crypto → credits
              </Text>
            </Suspense>
          </group>
        </group>

        {/* Vault door on the back wall, behind the counter */}
        <group position={[0, 3.4, -10.9]}>
          <mesh>
            <cylinderGeometry args={[2.5, 2.5, 0.5, 32]} />
            <meshStandardMaterial color="#5c6066" metalness={0.85} roughness={0.3} />
          </mesh>
          <mesh position={[0, 0, 0.28]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[1.15, 0.12, 12, 32]} />
            <meshStandardMaterial color="#c9ab6b" metalness={0.85} roughness={0.25} />
          </mesh>
          {[0, 1, 2].map((i) => (
            <mesh key={i} position={[0, 0, 0.3]} rotation={[Math.PI / 2, 0, (i * Math.PI) / 3]}>
              <boxGeometry args={[2.0, 0.09, 0.09]} />
              <meshStandardMaterial color="#c9ab6b" metalness={0.85} roughness={0.25} />
            </mesh>
          ))}
        </group>
        <Suspense fallback={null}>
          <Text position={[0, 7.6, -10.9]} fontSize={0.72} color="#4a443a" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" letterSpacing={0.22}>
            RESONANCE TRUST
          </Text>
          <Text position={[0, 6.7, -10.9]} fontSize={0.22} color="#7a7060" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" letterSpacing={0.3}>
            ONE LEDGER · ONE CREDIT · EVERY MARKET
          </Text>
        </Suspense>

        {/* Writing desk island */}
        <group position={[0, 0, 2.5]}>
          <mesh position={[0, 0.55, 0]} castShadow>
            <boxGeometry args={[3.4, 1.1, 1.4]} />
            <meshStandardMaterial color="#4a3521" roughness={0.55} />
          </mesh>
          <mesh position={[0, 1.15, 0]}>
            <boxGeometry args={[3.6, 0.08, 1.6]} />
            <meshStandardMaterial map={marble} roughness={0.3} />
          </mesh>
        </group>

        {/* A customer in line */}
        <group position={[-4.2, 0, -5.6]} rotation={[0, Math.PI, 0]}>
          <NpcFigure color="#5e5048" seed={53} />
        </group>

        {/* EXIT — back to the plaza */}
        <group
          onClick={exitClick}
          onPointerOver={() => (document.body.style.cursor = "pointer")}
          onPointerOut={() => (document.body.style.cursor = "auto")}
        >
          <mesh position={[0, 2.6, 9.9]} rotation={[0, Math.PI, 0]}>
            <planeGeometry args={[4.4, 4.8]} />
            <meshStandardMaterial
              color={phase.isNight ? "#1b2436" : "#dfe8ee"}
              emissive={phase.isNight ? "#26344e" : "#cfdde8"}
              emissiveIntensity={phase.isNight ? 0.3 : 0.55}
            />
          </mesh>
          {[-1.1, 1.1].map((x) => (
            <mesh key={x} position={[x, 2.4, 9.8]} rotation={[0, Math.PI, 0]}>
              <boxGeometry args={[1.9, 4.3, 0.08]} />
              <meshStandardMaterial color="#7a5c30" metalness={0.75} roughness={0.35} />
            </mesh>
          ))}
          <mesh position={[0, 5.3, 9.75]}>
            <boxGeometry args={[1.5, 0.55, 0.16]} />
            <meshStandardMaterial color="#132015" emissive="#0d3818" emissiveIntensity={0.8} />
          </mesh>
          <Suspense fallback={null}>
            <Text position={[0, 5.3, 9.62]} rotation={[0, Math.PI, 0]} fontSize={0.34} color="#6dff8f" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" letterSpacing={0.18}>
              EXIT
            </Text>
          </Suspense>
        </group>
      </Canvas>
    </div>
  );
}
