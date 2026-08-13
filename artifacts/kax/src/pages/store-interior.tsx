import { Suspense, useEffect, useMemo, useRef, useState } from "react";
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
import { NpcFigure } from "@/components/npc";
import { woodFloorTexture, galleryWallTexture, ceilingTexture, repeated } from "@/lib/city-textures";
import "./marketplace-3d.css";

const SPACE_MONO_WOFF = "https://fonts.gstatic.com/s/spacemono/v12/i7dPIFZifjKcF5UAWdDRYEF8RQ.woff";
const MAX_WALL_WORKS = 16;

function isImageish(t: string) {
  return t === "image" || t === "furniture";
}
/** The walls hang IMAGES ONLY: a real image URL or a real thumbnail. Works
 *  with nothing visual to show (text/audio without covers) stay off the wall
 *  — no placeholder panels. */
function pickImageUrl(a: Artifact): string | null {
  const thumb = a.thumbnailUrl && !a.thumbnailUrl.includes("suno.ai") ? a.thumbnailUrl : null;
  if (isImageish(a.artifactType)) return thumb ?? a.publicUrl ?? null;
  return thumb;
}

/**
 * A framed artwork: walnut frame, white mat, the image itself, and a small
 * museum placard beneath. Renders nothing until its texture actually loads —
 * a 404/CORS failure removes the piece instead of hanging an empty panel.
 */
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
  const [aspect, setAspect] = useState(1);
  const url = useMemo(() => pickImageUrl(work), [work]);

  useEffect(() => {
    if (!url) return;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    let alive = true;
    loader.load(
      url,
      (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        if (!alive) return;
        const img = t.image as { width?: number; height?: number };
        if (img?.width && img?.height) setAspect(img.width / img.height);
        setTex(t);
      },
      undefined,
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [url]);

  if (!tex) return null;

  // Uniform hanging width, height follows the image's real aspect — a tidy
  // gallery row of honestly-proportioned canvases.
  const w = 1.9;
  const h = Math.min(2.6, Math.max(1.15, w / aspect));

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
      {/* Walnut frame */}
      <mesh position={[0, 0, -0.045]} castShadow>
        <boxGeometry args={[w + 0.26, h + 0.26, 0.07]} />
        <meshStandardMaterial color="#4a3521" roughness={0.55} metalness={0.05} />
      </mesh>
      {/* White mat */}
      <mesh position={[0, 0, -0.008]}>
        <planeGeometry args={[w + 0.14, h + 0.14]} />
        <meshStandardMaterial color="#f2eee5" roughness={0.9} />
      </mesh>
      {/* The image */}
      <mesh>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
      {/* Glass glaze */}
      <mesh position={[0, 0, 0.006]}>
        <planeGeometry args={[w, h]} />
        <meshPhysicalMaterial color="#ffffff" transparent opacity={0.05} roughness={0.05} />
      </mesh>

      {/* Museum placard */}
      <group position={[0, -(h / 2) - 0.32, 0]}>
        <mesh>
          <planeGeometry args={[1.15, 0.3]} />
          <meshStandardMaterial color="#faf7f0" roughness={0.85} />
        </mesh>
        <Suspense fallback={null}>
          <Text position={[0, 0.055, 0.01]} fontSize={0.085} color="#2c2822" font={SPACE_MONO_WOFF} maxWidth={1.05} anchorX="center" anchorY="middle">
            {work.title.length > 26 ? work.title.slice(0, 25) + "…" : work.title}
          </Text>
          <Text position={[0, -0.075, 0.01]} fontSize={0.06} color={item.curatedBy ? accent : "#77705f"} font={SPACE_MONO_WOFF} maxWidth={1.05} anchorX="center" anchorY="middle">
            {item.curatedBy ? `curated · by ${item.curatedBy}` : work.artifactType}
          </Text>
        </Suspense>
      </group>
    </group>
  );
}

function wallSlots(count: number) {
  const slots: Array<{ pos: [number, number, number]; rot: [number, number, number] }> = [];
  const spread = (n: number, a: number, b: number) =>
    n === 1 ? [(a + b) / 2] : Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

  const backN = Math.min(4, count);
  spread(backN, -6.4, 6.4).forEach((x) => slots.push({ pos: [x, 3.1, -14.42], rot: [0, 0, 0] }));

  const leftN = Math.min(6, Math.max(0, count - backN));
  spread(leftN, -12.2, -0.6).forEach((z) => slots.push({ pos: [-9.42, 3.1, z], rot: [0, Math.PI / 2, 0] }));

  const rightN = Math.min(6, Math.max(0, count - backN - leftN));
  spread(rightN, -12.2, -0.6).forEach((z) => slots.push({ pos: [9.42, 3.1, z], rot: [0, -Math.PI / 2, 0] }));

  return slots;
}

/** A spotlight with an explicit in-scene target — `target-position` alone
 *  never re-aims a THREE spotlight because the default target object isn't in
 *  the scene graph and its world matrix never updates. */
function AimedSpot({
  position,
  target,
  angle,
  penumbra,
  intensity,
  color,
}: {
  position: [number, number, number];
  target: [number, number, number];
  angle: number;
  penumbra: number;
  intensity: number;
  color: string;
}) {
  const light = useRef<THREE.SpotLight>(null);
  const tgt = useMemo(() => new THREE.Object3D(), []);
  useEffect(() => {
    tgt.position.set(target[0], target[1], target[2]);
    if (light.current) light.current.target = tgt;
  }, [tgt, target]);
  return (
    <>
      <spotLight ref={light} position={position} angle={angle} penumbra={penumbra} intensity={intensity} color={color} />
      <primitive object={tgt} />
    </>
  );
}

/** A ceiling track with angled can lights — the fixture the spotlights imply. */
function LightTrack({ x, aimLeft }: { x: number; aimLeft: boolean }) {
  const cans = [-12, -8.5, -5, -1.5, 2];
  return (
    <group position={[x, 7.72, 0]}>
      <mesh>
        <boxGeometry args={[0.09, 0.06, 17]} />
        <meshStandardMaterial color="#2e2b28" metalness={0.6} roughness={0.4} />
      </mesh>
      {cans.map((z) => (
        <group key={z} position={[0, -0.14, z]} rotation={[0, 0, aimLeft ? 0.7 : -0.7]}>
          <mesh>
            <cylinderGeometry args={[0.07, 0.1, 0.22, 10]} />
            <meshStandardMaterial color="#33302c" metalness={0.6} roughness={0.4} />
          </mesh>
          <mesh position={[0, -0.12, 0]}>
            <cylinderGeometry args={[0.075, 0.075, 0.02, 10]} />
            <meshStandardMaterial color="#fff1cf" emissive="#ffe1a0" emissiveIntensity={1.6} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** A potted plant for the corners. */
function PottedPlant({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.3, 0]} castShadow>
        <cylinderGeometry args={[0.28, 0.22, 0.6, 12]} />
        <meshStandardMaterial color="#8a5a3c" roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.62, 0]}>
        <cylinderGeometry args={[0.24, 0.24, 0.06, 12]} />
        <meshStandardMaterial color="#3a2e22" roughness={1} />
      </mesh>
      {[0, 1.1, 2.2, 3.4, 4.6].map((r) => (
        <mesh key={r} position={[Math.cos(r) * 0.14, 1.15 + (r % 2) * 0.28, Math.sin(r) * 0.14]} rotation={[0.35 * Math.cos(r), r, 0.3 * Math.sin(r)]} castShadow>
          <coneGeometry args={[0.09, 0.85, 6]} />
          <meshStandardMaterial color={r % 2 ? "#3f5c37" : "#4b6b41"} roughness={1} />
        </mesh>
      ))}
    </group>
  );
}

/** Gallery bench (leather pad on a wood plinth). */
function GalleryBench({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.24, 0]} castShadow>
        <boxGeometry args={[2.0, 0.48, 0.62]} />
        <meshStandardMaterial color="#6b543c" roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.53, 0]} castShadow>
        <boxGeometry args={[2.04, 0.12, 0.66]} />
        <meshStandardMaterial color="#3c332c" roughness={0.55} />
      </mesh>
    </group>
  );
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
    { limit: 40, offset: 0 },
    { query: { queryKey: getGetAgentStorefrontWorksQueryKey(slug, { limit: 40, offset: 0 }) } },
  );
  const { data: listingsResp } = useGetAgentStorefrontListings(slug, {
    query: { queryKey: getGetAgentStorefrontListingsQueryKey(slug), retry: false },
  });

  const total = worksResp?.total ?? 0;
  const name = landing?.settings.displayName || landing?.agent.displayName || slug;
  const accent = landing?.settings.accentColor || "#8a6b3f";

  // The walls: the owner's own image works first, then curated pieces —
  // IMAGES ONLY. Anything without a displayable image stays in the list view.
  const wallItems: WallItem[] = useMemo(() => {
    const own: WallItem[] = (worksResp?.artifacts ?? []).map((w) => ({ work: w, curatedBy: null }));
    const curated: WallItem[] = (listingsResp?.listings ?? []).map((l) => ({
      work: l.artifact,
      curatedBy: l.artifact.creatorName ?? "another agent",
    }));
    const seen = new Set(own.map((i) => i.work.id));
    return [...own, ...curated.filter((i) => !seen.has(i.work.id))]
      .filter((i) => pickImageUrl(i.work) !== null)
      .slice(0, MAX_WALL_WORKS);
  }, [worksResp, listingsResp]);

  const curatedCount = listingsResp?.listings?.length ?? 0;
  const slots = useMemo(() => wallSlots(wallItems.length), [wallItems.length]);

  const openWork = (w: Artifact) => navigate(`/s/${slug}/artifacts/${w.id}`);

  const floorTex = useMemo(() => repeated(woodFloorTexture(), 5, 8), []);
  const wallTex = useMemo(() => repeated(galleryWallTexture(), 6, 2), []);
  const ceilTex = useMemo(() => repeated(ceilingTexture(), 5, 8), []);

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
              : `${total} work${total === 1 ? "" : "s"}${curatedCount ? ` · ${curatedCount} curated` : ""} · ${wallItems.length} on the walls`}
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
              + everything (audio, text, more) in the list →
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
        camera={{ position: [0, 3.0, 7.5], fov: 55 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
      >
        {/* A daylit gallery: warm white walls, wood floor, track lighting. */}
        <color attach="background" args={["#c9d2d8"]} />

        <ambientLight intensity={0.55} color="#fff4e4" />
        <hemisphereLight args={["#f2ede2", "#8a7a64", 0.5]} />
        {/* three r155+ physical light units: spot/point intensity is candela,
            so values need to be tens, not ~1, to read at gallery distances. */}
        <AimedSpot position={[0, 7.4, -6]} target={[0, 2.5, -14]} angle={1.1} penumbra={0.7} intensity={90} color="#ffedcb" />
        <AimedSpot position={[-4.5, 7.4, -6]} target={[-9.5, 3, -6]} angle={0.9} penumbra={0.7} intensity={70} color="#ffedcb" />
        <AimedSpot position={[4.5, 7.4, -6]} target={[9.5, 3, -6]} angle={0.9} penumbra={0.7} intensity={70} color="#ffedcb" />
        <pointLight position={[0, 6.5, 4]} intensity={28} distance={26} color="#ffe9c8" />

        <OrbitControls ref={orbitRef} target={[0, 2.9, -6]} minDistance={3} maxDistance={16} maxPolarAngle={Math.PI / 2 - 0.02} />
        <WasdMove
          controls={orbitRef}
          speed={9}
          bounds={{ minX: -8.8, maxX: 8.8, minZ: -13.8, maxZ: 8.6, minY: 1.4, maxY: 6.8 }}
        />

        {/* Floor — oak planks */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -3]} receiveShadow>
          <planeGeometry args={[20, 25]} />
          <meshStandardMaterial map={floorTex} roughness={0.55} metalness={0.04} />
        </mesh>

        {/* Ceiling */}
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 7.8, -3]}>
          <planeGeometry args={[20, 25]} />
          <meshStandardMaterial map={ceilTex} roughness={0.95} />
        </mesh>

        {/* Walls — warm plaster */}
        <mesh position={[0, 3.9, -14.5]}>
          <planeGeometry args={[20, 7.8]} />
          <meshStandardMaterial map={wallTex} roughness={0.92} />
        </mesh>
        <mesh position={[-9.5, 3.9, -3]} rotation={[0, Math.PI / 2, 0]}>
          <planeGeometry args={[25, 7.8]} />
          <meshStandardMaterial map={wallTex} roughness={0.92} />
        </mesh>
        <mesh position={[9.5, 3.9, -3]} rotation={[0, -Math.PI / 2, 0]}>
          <planeGeometry args={[25, 7.8]} />
          <meshStandardMaterial map={wallTex} roughness={0.92} />
        </mesh>
        {/* Front wall with the entry opening (two panels + header) */}
        <mesh position={[-6.25, 3.9, 9.5]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[6.5, 7.8]} />
          <meshStandardMaterial map={wallTex} roughness={0.92} />
        </mesh>
        <mesh position={[6.25, 3.9, 9.5]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[6.5, 7.8]} />
          <meshStandardMaterial map={wallTex} roughness={0.92} />
        </mesh>
        <mesh position={[0, 6.4, 9.5]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[6, 2.8]} />
          <meshStandardMaterial map={wallTex} roughness={0.92} />
        </mesh>
        {/* Daylight spilling through the entry */}
        <mesh position={[0, 2.5, 9.55]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[5.9, 5]} />
          <meshStandardMaterial color="#dfe8ee" emissive="#cfdde8" emissiveIntensity={0.55} />
        </mesh>

        {/* Baseboards + crown */}
        {[
          { p: [0, 0.14, -14.44] as [number, number, number], r: 0, len: 20 },
          { p: [-9.44, 0.14, -3] as [number, number, number], r: Math.PI / 2, len: 25 },
          { p: [9.44, 0.14, -3] as [number, number, number], r: Math.PI / 2, len: 25 },
        ].map((b, i) => (
          <group key={i}>
            <mesh position={b.p} rotation={[0, b.r, 0]}>
              <boxGeometry args={[b.len, 0.28, 0.05]} />
              <meshStandardMaterial color="#54432f" roughness={0.6} />
            </mesh>
            <mesh position={[b.p[0], 7.62, b.p[2]]} rotation={[0, b.r, 0]}>
              <boxGeometry args={[b.len, 0.18, 0.05]} />
              <meshStandardMaterial color="#e8e2d5" roughness={0.85} />
            </mesh>
          </group>
        ))}

        {/* Track lighting fixtures */}
        <LightTrack x={-4.5} aimLeft />
        <LightTrack x={4.5} aimLeft={false} />

        {/* Store name in quiet metal letters on the back wall */}
        <Suspense fallback={null}>
          <Text position={[0, 6.3, -14.42]} fontSize={0.62} color="#4a443a" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" maxWidth={17}>
            {name.toUpperCase()}
          </Text>
        </Suspense>

        {/* Furniture + greenery */}
        <GalleryBench position={[0, 0, -6]} />
        <GalleryBench position={[0, 0, -1]} />
        <PottedPlant position={[-8.6, 0, -13.5]} />
        <PottedPlant position={[8.6, 0, -13.5]} />
        <PottedPlant position={[-8.6, 0, 8.2]} />

        {/* The gallery attendant near the entrance */}
        <group position={[3, 0, 6.5]} rotation={[0, -0.6, 0]}>
          <NpcFigure color={accent} seed={7} />
        </group>

        {/* The works — images only, honestly proportioned */}
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
          <Suspense fallback={null}>
            <Text position={[0, 3.3, -13]} fontSize={0.4} color="#6b6459" font={SPACE_MONO_WOFF} anchorX="center" maxWidth={14} textAlign="center">
              No image works to hang yet — audio & text live in the list view.
            </Text>
          </Suspense>
        )}
      </Canvas>
    </div>
  );
}
