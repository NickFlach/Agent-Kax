import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Text } from "@react-three/drei";
import * as THREE from "three";
import { useParams, useLocation, Link } from "wouter";
import {
  useGetAgentStorefront,
  useGetAgentStorefrontWorks,
  useGetAgentStorefrontListings,
  getGetAgentStorefrontQueryKey,
  getGetAgentStorefrontWorksQueryKey,
  getGetAgentStorefrontListingsQueryKey,
} from "@workspace/api-client-react";
import type { Artifact } from "@workspace/api-client-react";

type WallItem = { work: Artifact; curatedBy: string | null };
import { Button } from "@/components/ui/button";
import { WasdMove } from "@/components/wasd-move";
import "./marketplace-3d.css";

const SPACE_MONO_WOFF = "https://fonts.gstatic.com/s/spacemono/v12/i7dPIFZifjKcF5UAWdDRYEF8RQ.woff";
const MAX_WALL_WORKS = 17;

function isImageish(t: string) {
  return t === "image" || t === "furniture";
}
function pickImageUrl(a: Artifact): string | null {
  const thumb = a.thumbnailUrl && !a.thumbnailUrl.includes("suno.ai") ? a.thumbnailUrl : null;
  if (isImageish(a.artifactType)) return thumb ?? a.publicUrl ?? null;
  return thumb; // audio/text: only if a real thumbnail exists
}

/** A framed artwork on the wall. Loads its texture imperatively with a
 *  fallback panel so a CORS/404 failure can never suspend-crash the room. */
function ArtworkFrame({
  item,
  position,
  rotation,
  accent,
  onOpen,
  onHover,
}: {
  item: WallItem;
  position: [number, number, number];
  rotation: [number, number, number];
  accent: string;
  onOpen: (w: Artifact) => void;
  onHover: (w: Artifact | null) => void;
}) {
  const work = item.work;
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  const [failed, setFailed] = useState(false);
  const url = useMemo(() => pickImageUrl(work), [work]);

  useEffect(() => {
    if (!url) {
      setFailed(true);
      return;
    }
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    let alive = true;
    loader.load(
      url,
      (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        if (alive) setTex(t);
      },
      undefined,
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [url]);

  const w = 2.4;
  const h = 2.4;
  return (
    <group
      position={position}
      rotation={rotation}
      onClick={(e) => {
        e.stopPropagation?.();
        onOpen(work);
      }}
      onPointerOver={(e) => {
        e.stopPropagation?.();
        onHover(work);
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        onHover(null);
        document.body.style.cursor = "auto";
      }}
    >
      {/* Frame border + backlight */}
      <mesh position={[0, 0, -0.04]}>
        <boxGeometry args={[w + 0.22, h + 0.22, 0.08]} />
        <meshStandardMaterial color="#0e2a30" emissive={accent} emissiveIntensity={0.25} />
      </mesh>
      {/* Canvas */}
      <mesh>
        <planeGeometry args={[w, h]} />
        {tex ? (
          <meshBasicMaterial map={tex} toneMapped={false} />
        ) : (
          <meshStandardMaterial color={failed ? "#0d242a" : "#123642"} emissive={accent} emissiveIntensity={0.18} />
        )}
      </mesh>
      {/* Placeholder label for non-image works */}
      {!tex && (
        <Text position={[0, 0, 0.05]} fontSize={0.22} color={accent} font={SPACE_MONO_WOFF} maxWidth={w - 0.3} anchorX="center" anchorY="middle" textAlign="center">
          {work.artifactType.toUpperCase()}
        </Text>
      )}
      {/* Little title placard under the frame */}
      <Text position={[0, -(h / 2) - 0.26, 0.05]} fontSize={0.16} color="#cfefe9" font={SPACE_MONO_WOFF} maxWidth={w} anchorX="center" anchorY="middle">
        {work.title.length > 26 ? work.title.slice(0, 25) + "…" : work.title}
      </Text>
      {item.curatedBy && (
        <Text position={[0, -(h / 2) - 0.48, 0.05]} fontSize={0.12} color={accent} font={SPACE_MONO_WOFF} maxWidth={w} anchorX="center" anchorY="middle">
          ◆ curated · by {item.curatedBy}
        </Text>
      )}
    </group>
  );
}

function wallSlots(count: number) {
  const slots: Array<{ pos: [number, number, number]; rot: [number, number, number] }> = [];
  const spread = (n: number, a: number, b: number) =>
    n === 1 ? [(a + b) / 2] : Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

  const backN = Math.min(5, count);
  spread(backN, -6, 6).forEach((x) => slots.push({ pos: [x, 3.3, -14.5], rot: [0, 0, 0] }));

  const leftN = Math.min(6, Math.max(0, count - backN));
  spread(leftN, -11.5, -2.5).forEach((z) => slots.push({ pos: [-9.5, 3.3, z], rot: [0, Math.PI / 2, 0] }));

  const rightN = Math.min(6, Math.max(0, count - backN - leftN));
  spread(rightN, -11.5, -2.5).forEach((z) => slots.push({ pos: [9.5, 3.3, z], rot: [0, -Math.PI / 2, 0] }));

  return slots;
}

export default function StoreInterior() {
  const { slug } = useParams<{ slug: string }>();
  const [, navigate] = useLocation();
  const [hovered, setHovered] = useState<Artifact | null>(null);
  const orbitRef = useRef<any>(null);

  const { data: landing } = useGetAgentStorefront(slug, {
    query: { queryKey: getGetAgentStorefrontQueryKey(slug), retry: false },
  });
  const { data: worksResp, isLoading } = useGetAgentStorefrontWorks(
    slug,
    { limit: MAX_WALL_WORKS, offset: 0 },
    { query: { queryKey: getGetAgentStorefrontWorksQueryKey(slug, { limit: MAX_WALL_WORKS, offset: 0 }) } },
  );
  const { data: listingsResp } = useGetAgentStorefrontListings(slug, {
    query: { queryKey: getGetAgentStorefrontListingsQueryKey(slug), retry: false },
  });

  const total = worksResp?.total ?? 0;
  const name = landing?.settings.displayName || landing?.agent.displayName || slug;
  const accent = landing?.settings.accentColor || "#00e5ff";

  // The store's walls: the owner's own works first, then curated pieces
  // (including other agents' works), each tagged with its true creator.
  const wallItems: WallItem[] = useMemo(() => {
    const own: WallItem[] = (worksResp?.artifacts ?? []).map((w) => ({ work: w, curatedBy: null }));
    const curated: WallItem[] = (listingsResp?.listings ?? []).map((l) => ({
      work: l.artifact,
      curatedBy: l.artifact.creatorName ?? "another agent",
    }));
    const seen = new Set(own.map((i) => i.work.id));
    return [...own, ...curated.filter((i) => !seen.has(i.work.id))].slice(0, MAX_WALL_WORKS);
  }, [worksResp, listingsResp]);

  const curatedCount = listingsResp?.listings?.length ?? 0;
  const slots = useMemo(() => wallSlots(wallItems.length), [wallItems.length]);

  const openWork = (w: Artifact) => navigate(`/s/${slug}/artifacts/${w.id}`);

  return (
    <div className="relative h-screen w-full bg-[#0a1a24] overflow-hidden kax3d-font">
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-4 pointer-events-none">
        <Link href="/marketplace" className="font-bold tracking-[0.3em] uppercase text-primary pointer-events-auto hover:text-primary/80" data-testid="link-back-market">
          ← KAX
        </Link>
        <Link href={`/s/${slug}`} className="pointer-events-auto text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground border border-border px-3 py-2">
          List view
        </Link>
      </div>

      {/* HUD */}
      <div className="absolute top-16 left-0 p-6 z-10 pointer-events-none">
        <div className="kax3d-hud p-5 rounded-none max-w-sm pointer-events-auto">
          <p className="text-[10px] text-accent font-bold uppercase tracking-[0.3em] mb-1">Store Interior</p>
          <h1 className="text-xl font-bold text-foreground tracking-widest uppercase" data-testid="text-store-name">{name}</h1>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">
            {isLoading
              ? "hanging the walls…"
              : `${total} work${total === 1 ? "" : "s"}${curatedCount ? ` · ${curatedCount} curated` : ""} · showing ${wallItems.length}`}
          </p>
          <div className="mt-4 border-t border-border pt-3 min-h-[2.5rem]">
            {hovered ? (
              <div>
                <p className="text-sm text-foreground font-medium">{hovered.title}</p>
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">{hovered.artifactType} · click to open</p>
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest">Look around · click a piece to open it</p>
            )}
          </div>
          {total > wallItems.length && (
            <Link href={`/s/${slug}`} className="pointer-events-auto text-[10px] uppercase tracking-widest text-accent hover:text-foreground mt-3 inline-block">
              + more in the list →
            </Link>
          )}
        </div>
      </div>

      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-[0.4em] text-muted-foreground pointer-events-none z-10 font-bold">
        WASD to walk · Drag to look · Click a piece · R/F up-down
      </div>

      <Canvas
        className="!absolute inset-0"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        camera={{ position: [0, 3.2, 11], fov: 55 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
      >
        <color attach="background" args={["#0a1a24"]} />
        <fog attach="fog" args={["#0a1620", 18, 40]} />

        <ambientLight intensity={0.5} color="#3d6b78" />
        <hemisphereLight args={["#5a8a95", "#0a1620", 0.7]} />
        <spotLight position={[0, 7.5, 4]} angle={0.8} penumbra={0.6} intensity={1.2} color="#ffe6c0" />
        <pointLight position={[-7, 6, -8]} intensity={0.7} distance={40} color={accent} />
        <pointLight position={[7, 6, -8]} intensity={0.7} distance={40} color="#E8A33D" />

        <OrbitControls ref={orbitRef} target={[0, 3, -6]} minDistance={3} maxDistance={16} maxPolarAngle={Math.PI / 2 - 0.02} />
        <WasdMove
          controls={orbitRef}
          speed={9}
          bounds={{ minX: -9, maxX: 9, minZ: -14, maxZ: 9, minY: 1.4, maxY: 6.5 }}
        />

        {/* Room shell */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -5]}>
          <planeGeometry args={[20, 32]} />
          <meshStandardMaterial color="#0c2028" roughness={0.7} metalness={0.3} />
        </mesh>
        {/* subtle floor grid */}
        <gridHelper args={[20, 20, "#1f6b74", "#12303a"]} position={[0, 0.02, -5]} />
        <mesh position={[0, 4, -15]}>
          <planeGeometry args={[20, 8]} />
          <meshStandardMaterial color="#0e2630" roughness={0.85} />
        </mesh>
        <mesh position={[-10, 4, -5]} rotation={[0, Math.PI / 2, 0]}>
          <planeGeometry args={[32, 8]} />
          <meshStandardMaterial color="#0d2028" roughness={0.85} />
        </mesh>
        <mesh position={[10, 4, -5]} rotation={[0, -Math.PI / 2, 0]}>
          <planeGeometry args={[32, 8]} />
          <meshStandardMaterial color="#0d2028" roughness={0.85} />
        </mesh>
        {/* Neon baseboards for depth */}
        <mesh position={[0, 0.1, -14.9]}>
          <boxGeometry args={[20, 0.06, 0.06]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={1.6} toneMapped={false} />
        </mesh>

        {/* Store name across the back wall */}
        <Text position={[0, 6.6, -14.8]} fontSize={0.9} color={accent} font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" maxWidth={18}>
          {name.toUpperCase()}
        </Text>

        {/* The works, hung on the walls (own works + curated pieces) */}
        {wallItems.map((it, i) =>
          slots[i] ? (
            <ArtworkFrame
              key={`${it.work.id}-${it.curatedBy ? "c" : "o"}`}
              item={it}
              position={slots[i].pos}
              rotation={slots[i].rot}
              accent={accent}
              onOpen={openWork}
              onHover={setHovered}
            />
          ) : null,
        )}

        {isLoading || wallItems.length > 0 ? null : (
          <Text position={[0, 3.3, -13]} fontSize={0.4} color="#8aa" font={SPACE_MONO_WOFF} anchorX="center" maxWidth={14} textAlign="center">
            This store has no works on the walls yet.
          </Text>
        )}
      </Canvas>
    </div>
  );
}
