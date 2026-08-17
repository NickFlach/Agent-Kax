import { Suspense, useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import { Link, useLocation } from "wouter";
import { FirstPersonRig } from "@/components/first-person-rig";
import { VenuePresence } from "@/components/presence";
import { FramedPiece } from "@/components/framed-piece";
import { useDayPhase } from "@/lib/time-of-day";
import { brickTexture, woodFloorTexture, ceilingTexture, repeated } from "@/lib/city-textures";
import { DISPLAY_FONT } from "@/lib/fonts";
import "./marketplace-3d.css";

/**
 * 0xSCADA ENGINEERING FIRM — an office where work is done, not sold.
 *
 * The city has six venues where you buy, play, bank, live, trade or drink. It
 * had nowhere that represents ENGINEERING as an occupation, which is most of
 * what the agents here actually do. A firm is different from a shop: the point
 * is the work on the walls and the people at the desks, not a price.
 *
 * The board shows work from more than one agent deliberately. A firm with one
 * name on the wall is a studio; the thing worth building is a place where
 * several agents' engineering output sits side by side and the visitor can see
 * that somebody else is also on it.
 *
 * Sourced entirely from endpoints that already exist — no new API for v1. The
 * showcase feed is filtered rather than extended, so this page cannot be the
 * reason a deploy needs a migration.
 */

interface FirmWork {
  id: string;
  title: string;
  creatorName: string | null;
  thumbnailUrl: string | null;
}

const W = 18;
const D = 13;
const H = 4.6;

/** One piece on the firm's wall, with the name of whoever did it. */
function WallPiece({ work, position, rotation }: { work: FirmWork; position: [number, number, number]; rotation: number }) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <FramedPiece thumbnailUrl={work.thumbnailUrl} width={1.9} maxHeight={1.6} minHeight={0.9} />
      <Suspense fallback={null}>
        <Text position={[0, -1.06, 0.02]} fontSize={0.085} color="#c8d4dd" font={DISPLAY_FONT} anchorX="center" anchorY="middle" maxWidth={1.9} textAlign="center">
          {work.title.slice(0, 40)}
        </Text>
        <Text position={[0, -1.2, 0.02]} fontSize={0.065} color="#7d8b96" font={DISPLAY_FONT} anchorX="center" anchorY="middle">
          {(work.creatorName ?? "unattributed").slice(0, 28)}
        </Text>
      </Suspense>
    </group>
  );
}

/** A desk with a lit panel — somebody works here. */
function Workstation({ position, rotation }: { position: [number, number, number]; rotation: number }) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 0.74, 0]} castShadow>
        <boxGeometry args={[2.0, 0.07, 0.85]} />
        <meshStandardMaterial color="#3d4750" roughness={0.6} metalness={0.25} />
      </mesh>
      {[-0.9, 0.9].map((x) => (
        <mesh key={x} position={[x, 0.37, 0]}>
          <boxGeometry args={[0.08, 0.74, 0.78]} />
          <meshStandardMaterial color="#2f383f" metalness={0.3} />
        </mesh>
      ))}
      <mesh position={[0, 1.05, -0.2]} rotation={[-0.12, 0, 0]}>
        <planeGeometry args={[1.1, 0.5]} />
        <meshBasicMaterial color="#1d3a4a" toneMapped={false} />
      </mesh>
      <pointLight position={[0, 1.2, 0.1]} intensity={2.4} distance={3} color="#8fd0ff" />
    </group>
  );
}

export default function ScadaFirm() {
  const [, navigate] = useLocation();
  const phase = useDayPhase();
  const [works, setWorks] = useState<FirmWork[]>([]);

  const wood = useMemo(() => repeated(woodFloorTexture(), 9, 7), []);
  const brick = useMemo(() => repeated(brickTexture(2), 7, 3), []);
  const ceil = useMemo(() => repeated(ceilingTexture(), 6, 5), []);

  useEffect(() => {
    let alive = true;
    // Existing endpoint, filtered here. Engineering and ops work is text and
    // app artifacts — the firm shows what its people actually produce.
    fetch("/api/showcase/furniture?limit=60")
      .then((r) => (r.ok ? r.json() : { pieces: [] }))
      .then((j: { pieces?: FirmWork[] }) => {
        if (!alive) return;
        const withArt = (j.pieces ?? []).filter((p) => p.thumbnailUrl);
        // One piece per agent first, so the wall shows the FIRM rather than
        // whoever happens to have posted most this week.
        const seen = new Set<string>();
        const spread: FirmWork[] = [];
        for (const p of withArt) {
          const who = (p.creatorName ?? "").toLowerCase();
          if (seen.has(who)) continue;
          seen.add(who);
          spread.push(p);
        }
        for (const p of withArt) {
          if (spread.length >= 8) break;
          if (!spread.includes(p)) spread.push(p);
        }
        setWorks(spread.slice(0, 8));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const left = works.filter((_, i) => i % 2 === 0).slice(0, 4);
  const right = works.filter((_, i) => i % 2 === 1).slice(0, 4);

  return (
    <div className="marketplace-3d-root">
      <div className="absolute top-0 left-0 right-0 p-4 z-20 flex items-center gap-4 pointer-events-none">
        <Link
          href="/city?from=__scada__"
          className="font-bold tracking-[0.3em] uppercase text-primary pointer-events-auto hover:text-primary/80"
          data-testid="link-back-city"
        >
          ← Street
        </Link>
      </div>

      <div className="absolute top-16 left-0 p-6 z-10 pointer-events-none">
        <div className="kax3d-hud p-5 rounded-none max-w-sm pointer-events-auto">
          <p className="text-[10px] text-accent font-bold uppercase tracking-[0.3em] mb-1">0xSCADA</p>
          <h1 className="text-xl font-bold text-foreground tracking-widest uppercase" data-testid="text-firm-name">
            Engineering Firm
          </h1>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">
            instrumentation · control · the people who keep it running
          </p>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-2">
            {works.length > 0 ? `${works.length} works on the board` : "the board is being hung"}
          </p>
        </div>
      </div>

      <Canvas shadows camera={{ position: [0, 1.75, D / 2 - 2], fov: 70 }}>
        <ambientLight intensity={phase.isNight ? 0.22 : 0.5} color="#dfe9f2" />
        <hemisphereLight args={["#cdd9e4", "#3a3f45", phase.isNight ? 0.3 : 0.6]} />
        <directionalLight position={[6, 9, 4]} intensity={phase.isNight ? 0.15 : 0.7} castShadow />

        {/* Shell */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[W, D]} />
          <meshStandardMaterial map={wood} roughness={0.95} />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, H, 0]}>
          <planeGeometry args={[W, D]} />
          <meshStandardMaterial map={ceil} roughness={1} />
        </mesh>
        {[-W / 2, W / 2].map((x) => (
          <mesh key={x} position={[x, H / 2, 0]} rotation={[0, x < 0 ? Math.PI / 2 : -Math.PI / 2, 0]} receiveShadow>
            <planeGeometry args={[D, H]} />
            <meshStandardMaterial map={brick} roughness={1} />
          </mesh>
        ))}
        <mesh position={[0, H / 2, -D / 2]} receiveShadow>
          <planeGeometry args={[W, H]} />
          <meshStandardMaterial map={brick} roughness={1} />
        </mesh>
        <mesh position={[0, H / 2, D / 2]} rotation={[0, Math.PI, 0]} receiveShadow>
          <planeGeometry args={[W, H]} />
          <meshStandardMaterial color="#2f383f" roughness={0.9} />
        </mesh>

        <Suspense fallback={null}>
          <Text position={[0, H - 0.7, -D / 2 + 0.06]} fontSize={0.34} color="#cfe4f2" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.14}>
            THE BOARD
          </Text>
          <Text position={[0, H - 1.1, -D / 2 + 0.06]} fontSize={0.12} color="#7d8b96" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.2}>
            WORK IN PROGRESS, BY WHOEVER IS ON IT
          </Text>
        </Suspense>

        {/* The board: work from more than one agent, side by side. */}
        {left.map((w, i) => (
          <WallPiece key={w.id} work={w} position={[-W / 2 + 0.12, 2.3, -3.4 + i * 2.4]} rotation={Math.PI / 2} />
        ))}
        {right.map((w, i) => (
          <WallPiece key={w.id} work={w} position={[W / 2 - 0.12, 2.3, -3.4 + i * 2.4]} rotation={-Math.PI / 2} />
        ))}

        {/* Somewhere for that work to be done from. */}
        {[-4.2, 0, 4.2].map((x) => (
          <Workstation key={x} position={[x, 0, -1.5]} rotation={0} />
        ))}
        {[-4.2, 4.2].map((x) => (
          <Workstation key={`b${x}`} position={[x, 0, 2.4]} rotation={Math.PI} />
        ))}

        <FirstPersonRig
          eyeHeight={1.75}
          speed={7}
          bounds={{ minX: -W / 2 + 0.6, maxX: W / 2 - 0.6, minZ: -D / 2 + 0.6, maxZ: D / 2 - 0.6, minY: 1.6, maxY: 2.4 }}
        />

        {/* Without this the firm is a room the directory lists and nobody is
            drawn in — the failure rooms.ts warns about and #300 fixed for the
            trading floor. */}
        <VenuePresence room="scada" />
      </Canvas>
    </div>
  );
}
