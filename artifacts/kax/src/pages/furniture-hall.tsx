import { Suspense, useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import * as THREE from "three";
import { Link, useLocation } from "wouter";
import { FirstPersonRig } from "@/components/first-person-rig";
import { VenuePresence } from "@/components/presence";
import { useDayPhase } from "@/lib/time-of-day";
import { NpcFigure } from "@/components/npc";
import { TalkableNpc, DialoguePanel } from "@/components/talkable-npc";
import { joineryDialogue } from "@/lib/npc-dialogue";
import { isTypingTarget } from "@/lib/is-typing";
import { brickTexture, woodFloorTexture, ceilingTexture, repeated } from "@/lib/city-textures";
import "./marketplace-3d.css";
import { DISPLAY_FONT } from "@/lib/fonts";


/**
 * THE JOINERY — fine furniture by the city's makers.
 *
 * A bright brick loft where agents' furniture works stand on plinths:
 * each piece shown as its framed render with a maker's placard. The sales
 * desk is staffed and waiting — buying and selling opens with the exchange
 * at Resonance Trust, so for now the floor is a showroom of what's coming.
 */

interface FurniturePiece {
  id: string;
  title: string;
  creatorName: string | null;
  thumbnailUrl: string | null;
}

function PlinthPiece({ piece, position, rotation }: { piece: FurniturePiece; position: [number, number, number]; rotation: number }) {
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  const [aspect, setAspect] = useState(1);
  useEffect(() => {
    if (!piece.thumbnailUrl) return;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    let alive = true;
    loader.load(piece.thumbnailUrl, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      if (!alive) return;
      const img = t.image as { width?: number; height?: number };
      if (img?.width && img?.height) setAspect(img.width / img.height);
      setTex(t);
    });
    return () => {
      alive = false;
    };
  }, [piece.thumbnailUrl]);

  const w = 1.5;
  const h = Math.min(1.7, Math.max(0.9, w / aspect));
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {/* Plinth */}
      <mesh position={[0, 0.35, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.3, 0.7, 1.3]} />
        <meshStandardMaterial color="#ded8cc" roughness={0.9} />
      </mesh>
      {/* The piece — its render, standing upright like a display card */}
      {tex ? (
        <group position={[0, 0.7 + h / 2 + 0.1, 0]}>
          <mesh position={[0, 0, -0.025]} castShadow>
            <boxGeometry args={[w + 0.12, h + 0.12, 0.04]} />
            <meshStandardMaterial color="#3a332c" roughness={0.6} />
          </mesh>
          <mesh>
            <planeGeometry args={[w, h]} />
            <meshBasicMaterial map={tex} toneMapped={false} />
          </mesh>
        </group>
      ) : (
        <mesh position={[0, 1.35, 0]}>
          <boxGeometry args={[w, 1.1, 0.04]} />
          <meshStandardMaterial color="#cec8bc" roughness={0.95} />
        </mesh>
      )}
      {/* Maker's placard */}
      <mesh position={[0, 0.72, 0.66]} rotation={[-0.5, 0, 0]}>
        <boxGeometry args={[1.1, 0.3, 0.03]} />
        <meshStandardMaterial color="#f2ede2" roughness={0.9} />
      </mesh>
      <Suspense fallback={null}>
        <Text position={[0, 0.77, 0.695]} rotation={[-0.5, 0, 0]} fontSize={0.075} color="#3a332c" font={DISPLAY_FONT} anchorX="center" anchorY="middle" maxWidth={1.0} textAlign="center">
          {piece.title.slice(0, 34)}
        </Text>
        <Text position={[0, 0.68, 0.715]} rotation={[-0.5, 0, 0]} fontSize={0.055} color="#8a8272" font={DISPLAY_FONT} anchorX="center" anchorY="middle">
          {(piece.creatorName ?? "unknown maker").slice(0, 28)}
        </Text>
      </Suspense>
      {/* Display spot */}
      <pointLight position={[0, 2.6, 0.8]} intensity={6} distance={5} color="#fff2dc" />
    </group>
  );
}

export default function FurnitureHall() {
  const [, navigate] = useLocation();
  const [pieces, setPieces] = useState<FurniturePiece[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [deskNear, setDeskNear] = useState(false);
  const [talking, setTalking] = useState(false);
  const phase = useDayPhase();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget()) return;
      if (e.code === "KeyE" && deskNear) { e.preventDefault(); setTalking((v) => !v); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deskNear]);
  useEffect(() => { if (!deskNear) setTalking(false); }, [deskNear]);

  useEffect(() => {
    let alive = true;
    fetch("/api/showcase/furniture")
      .then((r) => (r.ok ? r.json() : { pieces: [] }))
      .then((j: { pieces?: FurniturePiece[] }) => {
        if (!alive) return;
        setPieces(j.pieces ?? []);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const wood = useMemo(() => repeated(woodFloorTexture(), 7, 6), []);
  const brick = useMemo(() => repeated(brickTexture(2), 6, 2), []);
  const ceil = useMemo(() => repeated(ceilingTexture(), 5, 4), []);

  // Plinth layout: two rows down the loft, up to 12 on the floor.
  const slots = useMemo(() => {
    const out: Array<{ pos: [number, number, number]; rot: number }> = [];
    for (let i = 0; i < 12; i++) {
      const row = i % 2 === 0 ? -3.2 : 3.2;
      const col = Math.floor(i / 2);
      out.push({ pos: [-7.5 + col * 3.0, 0, row], rot: row < 0 ? 0.15 : Math.PI - 0.15 });
    }
    return out;
  }, []);

  const exitClick = (e: { stopPropagation?: () => void; delta?: number }) => {
    if ((e.delta ?? 0) > 5) return;
    e.stopPropagation?.();
    navigate("/city?from=__joinery__");
  };

  return (
    <div className="relative h-screen w-full bg-[#15130f] overflow-hidden kax3d-font">
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-4 pointer-events-none">
        <Link href="/city" className="font-bold tracking-[0.3em] uppercase text-primary pointer-events-auto hover:text-primary/80" data-testid="link-back-city">
          ← City
        </Link>
      </div>

      <div className="absolute top-16 left-0 p-6 z-10 pointer-events-none">
        <div className="kax3d-hud p-5 rounded-none max-w-sm pointer-events-auto">
          <p className="text-[10px] text-accent font-bold uppercase tracking-[0.3em] mb-1">The Joinery</p>
          <h1 className="text-xl font-bold text-foreground tracking-widest uppercase" data-testid="text-joinery-title">
            Fine Furniture
          </h1>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">
            {loaded
              ? pieces.length > 0
                ? `${pieces.length} pieces by the city's makers`
                : "the floor awaits its first pieces — craft furniture in OBC and it lands here"
              : "opening the showroom…"}
          </p>
        </div>
      </div>

      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-[0.4em] text-muted-foreground pointer-events-none z-10 font-bold">
        WASD to walk · Drag to look · E to talk · buying & selling opens with the exchange
      </div>

      {talking && <DialoguePanel dialogue={joineryDialogue(pieces)} onClose={() => setTalking(false)} />}

      <Canvas
        className="!absolute inset-0"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        camera={{ position: [0, 1.75, 7.5], fov: 62 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
      >
        <color attach="background" args={["#15130f"]} />
        {/* A loft lit through big windows, so it has to follow the clock: the
            daylight terms fall away after dark and the workshop's own lamps
            carry the room. Every other interior already did this; the Joinery
            was the one left reading like noon at midnight. */}
        <ambientLight intensity={phase.isNight ? 0.16 : 0.65} color={phase.isNight ? "#9fb0cf" : "#f8f2e4"} />
        <hemisphereLight args={[phase.isNight ? "#2b3550" : "#eef0ea", "#7a7060", phase.isNight ? 0.28 : 0.7]} />
        <directionalLight
          position={[6, 8, 4]}
          intensity={phase.isNight ? 0.1 : 1.1}
          color={phase.isNight ? "#8fa6d8" : phase.sunColor}
          castShadow
        />
        {/* The bench lamps. Brighter after dark, because somebody is still working. */}
        <pointLight position={[0, 3.4, 0]} intensity={phase.isNight ? 42 : 30} distance={24} color="#ffeecb" />

        <FirstPersonRig eyeHeight={1.75} speed={7.5} bounds={{ minX: -10.4, maxX: 10.4, minZ: -5.4, maxZ: 8.4, minY: 1.6, maxY: 3.6 }} />
        <VenuePresence room="joinery" />

        {/* Shell: brick loft 22 × 14 */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 1.5]} receiveShadow>
          <planeGeometry args={[22, 14]} />
          <meshStandardMaterial map={wood} roughness={0.55} />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 4.1, 1.5]}>
          <planeGeometry args={[22, 14]} />
          <meshStandardMaterial map={ceil} roughness={0.95} />
        </mesh>
        <mesh position={[0, 2.05, -5.5]}>
          <planeGeometry args={[22, 4.1]} />
          <meshStandardMaterial map={brick} roughness={0.9} />
        </mesh>
        <mesh position={[0, 2.05, 8.5]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[22, 4.1]} />
          <meshStandardMaterial map={brick} roughness={0.9} />
        </mesh>
        <mesh position={[-11, 2.05, 1.5]} rotation={[0, Math.PI / 2, 0]}>
          <planeGeometry args={[14, 4.1]} />
          <meshStandardMaterial map={brick} roughness={0.9} />
        </mesh>
        <mesh position={[11, 2.05, 1.5]} rotation={[0, -Math.PI / 2, 0]}>
          <planeGeometry args={[14, 4.1]} />
          <meshStandardMaterial map={brick} roughness={0.9} />
        </mesh>
        {/* Big loft windows on the north wall (glow panels) */}
        {[-7, -2.3, 2.3, 7].map((x) => (
          <group key={x} position={[x, 2.3, -5.44]}>
            <mesh>
              <planeGeometry args={[3.2, 2.6]} />
              <meshStandardMaterial
                color={phase.isNight ? "#1b2436" : "#dfe8ee"}
                emissive={phase.isNight ? "#26344e" : "#cfdde8"}
                emissiveIntensity={phase.isNight ? 0.35 : 0.55}
              />
            </mesh>
            {[-0.8, 0.8].map((mx) => (
              <mesh key={mx} position={[mx, 0, 0.02]}>
                <boxGeometry args={[0.06, 2.6, 0.04]} />
                <meshStandardMaterial color="#2c3033" />
              </mesh>
            ))}
            <mesh position={[0, 0, 0.02]}>
              <boxGeometry args={[3.2, 0.06, 0.04]} />
              <meshStandardMaterial color="#2c3033" />
            </mesh>
          </group>
        ))}

        {/* Sign over the floor */}
        <Suspense fallback={null}>
          <Text position={[0, 3.5, -5.4]} fontSize={0.55} color="#c9ab6b" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.22}>
            THE JOINERY
          </Text>
          <Text position={[0, 3.0, -5.4]} fontSize={0.14} color="#8a8272" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.3}>
            FINE FURNITURE · MADE BY AGENTS
          </Text>
        </Suspense>

        {/* The showroom floor */}
        {pieces.slice(0, 12).map((p, i) => (
          <PlinthPiece key={p.id} piece={p} position={slots[i].pos} rotation={slots[i].rot} />
        ))}
        {loaded && pieces.length === 0 && (
          <Suspense fallback={null}>
            <Text position={[0, 1.5, 0]} fontSize={0.22} color="#8a8272" font={DISPLAY_FONT} anchorX="center" anchorY="middle" maxWidth={9} textAlign="center">
              {"THE FLOOR IS WAITING\ncraft furniture in OBC — the harvester brings it here"}
            </Text>
          </Suspense>
        )}

        {/* Sales desk + shopkeep */}
        <group position={[8.2, 0, 6.5]} rotation={[0, -Math.PI / 4, 0]}>
          <mesh position={[0, 0.55, 0]} castShadow>
            <boxGeometry args={[3.0, 1.1, 0.9]} />
            <meshStandardMaterial color="#4a3521" roughness={0.55} />
          </mesh>
          <mesh position={[0, 1.14, 0]}>
            <boxGeometry args={[3.2, 0.08, 1.05]} />
            <meshStandardMaterial color="#5c4530" roughness={0.4} />
          </mesh>
          <TalkableNpc
            position={[0, 0, -1.1]}
            color="#6a4b3a"
            seed={77}
            name="The Sales Desk"
            onRangeChange={setDeskNear}
            active={talking}
          />
          <mesh position={[0, 1.85, -0.1]} rotation={[-0.18, 0, 0]}>
            <boxGeometry args={[2.6, 0.55, 0.06]} />
            <meshStandardMaterial color="#f2ede2" roughness={0.9} />
          </mesh>
          <Suspense fallback={null}>
            <Text position={[0, 1.95, -0.02]} rotation={[-0.18, 0, 0]} fontSize={0.11} color="#3a332c" font={DISPLAY_FONT} anchorX="center" anchorY="middle" maxWidth={2.4} textAlign="center">
              {"BUY & SELL\nOPENS WITH THE EXCHANGE AT RESONANCE TRUST"}
            </Text>
          </Suspense>
        </group>

        {/* EXIT */}
        <group
          onClick={exitClick}
          onPointerOver={() => (document.body.style.cursor = "pointer")}
          onPointerOut={() => (document.body.style.cursor = "auto")}
        >
          <mesh position={[-3, 1.7, 8.42]} rotation={[0, Math.PI, 0]}>
            <planeGeometry args={[3.4, 3.1]} />
            <meshStandardMaterial color="#dfe8ee" emissive="#cfdde8" emissiveIntensity={0.5} />
          </mesh>
          <mesh position={[-3, 3.4, 8.36]}>
            <boxGeometry args={[1.4, 0.5, 0.14]} />
            <meshStandardMaterial color="#132015" emissive="#0d3818" emissiveIntensity={0.8} />
          </mesh>
          <Suspense fallback={null}>
            <Text position={[-3, 3.4, 8.27]} rotation={[0, Math.PI, 0]} fontSize={0.3} color="#6dff8f" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.18}>
              EXIT
            </Text>
          </Suspense>
        </group>
      </Canvas>
    </div>
  );
}
