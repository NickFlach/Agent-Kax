import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import * as THREE from "three";
import { useParams, useLocation, Link } from "wouter";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  useGetAgentStorefront,
  useGetAgentStorefrontListings,
  getGetAgentStorefrontQueryKey,
  getGetAgentStorefrontListingsQueryKey,
} from "@workspace/api-client-react";
import type { Artifact } from "@workspace/api-client-react";

type WallItem = { work: Artifact; curatedBy: string | null };
import { Button } from "@/components/ui/button";
import { FirstPersonRig, type FpsSpawn } from "@/components/first-person-rig";
import {
  ARCADE_SLOT_X,
  ARCADE_Z,
  BENCH_POSITIONS,
  DESK_POSITION,
  DESK_SPAWN,
  PLANT_POSITIONS,
  storeObstacles,
} from "@/lib/room-geometry";
import { NpcFigure } from "@/components/npc";
import { TalkableNpc } from "@/components/talkable-npc";
import { PurchasePanel } from "@/components/purchase-panel";
import { useAuth } from "@/hooks/use-auth";
import { isTypingTarget } from "@/lib/is-typing";
import { fetchPhysicalProducts, formatMoney, type PhysicalProduct } from "@/lib/commerce";
import { woodFloorTexture, galleryWallTexture, ceilingTexture, repeated } from "@/lib/city-textures";
import { ArcadeCabinet, PlayOverlay, type PlayableApp } from "@/components/arcade-shared";
import "./marketplace-3d.css";
import { DISPLAY_FONT } from "@/lib/fonts";

const MAX_WALL_WORKS = 16;

/**
 * The floor's measurements live in `lib/room-geometry.ts`, not here.
 *
 * They are arithmetic — where the desk stands, which boxes the rig collides
 * against, how far away a clerk will still talk to you — and this module cannot
 * be imported by the test runner, because everything above pulls in three.js
 * and @react-three/fiber. Both of the bugs those numbers had (a proximity check
 * in the wrong coordinate space, an obstacle list missing the arcade cabinets)
 * were invisible in a render and provable in three lines of arithmetic, so they
 * live where a Node test can reach them.
 */

function isImageish(t: string) {
  return t === "image" || t === "furniture";
}
/** The walls hang IMAGES ONLY: a real image URL or a real thumbnail. Works
 *  with nothing visual to show (text/audio without covers) stay off the wall
 *  — no placeholder panels. `inline:` thumbnails are sentinels, not URLs. */
function pickImageUrl(a: Artifact): string | null {
  const raw = a.thumbnailUrl;
  const thumb = raw && !raw.includes("suno.ai") && !raw.startsWith("inline:") ? raw : null;
  if (isImageish(a.artifactType)) return thumb ?? a.publicUrl ?? null;
  return thumb;
}

/** A playable video work: the new OBC artifact type, hung like a painting.
 *  (Cast: the generated schema predates the city's video/app types.) */
function isPlayableVideo(a: Artifact): boolean {
  return (a.artifactType as string) === "video" && !!a.publicUrl && !a.publicUrl.startsWith("inline:");
}

/**
 * An APP work — the city's live-HTML arcade games and tools. Explicit app-ish
 * types count; bare `link` works count only when the URL looks like a hosted
 * app (so "now on YouTube" links don't become arcade cabinets).
 */
function isAppWork(a: Artifact): boolean {
  const t = String(a.artifactType);
  if (/^(app|apps|arcade|game|html)$/i.test(t)) return !!a.publicUrl;
  if (t === "link" && a.publicUrl) return /\.html?($|[?#])|\/(apps?|arcade|games?)\//i.test(a.publicUrl);
  return false;
}

/**
 * The works feed is newest-first and an active agent's recent output can be
 * all text/audio (Kannaka: 31 text + 8 audio + 1 image in her latest 40 —
 * which is why her gallery hung a single painting). Page through the catalog
 * until the walls are FULL of hangable works — images, plus up to a few
 * playable VIDEO works (the city's newest medium) — not just whatever
 * happened to be posted last.
 */
function useWallWorks(slug: string, want: number, maxVideos = 4, maxApps = 4) {
  const [works, setWorks] = useState<Artifact[]>([]);
  const [apps, setApps] = useState<Artifact[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const images: Artifact[] = [];
      const videos: Artifact[] = [];
      const appWorks: Artifact[] = [];
      let tot = 0;
      try {
        for (
          let page = 0;
          page < 8 && (images.length + Math.min(videos.length, maxVideos) < want || appWorks.length < maxApps);
          page++
        ) {
          const r = await fetch(`/api/storefront/by-agent/${encodeURIComponent(slug)}/works?limit=100&offset=${page * 100}`);
          if (!r.ok) break;
          const j = (await r.json()) as { total?: number; artifacts?: Artifact[] };
          tot = j.total ?? tot;
          const batch = j.artifacts ?? [];
          for (const a of batch) {
            if (isAppWork(a)) appWorks.push(a);
            else if (isPlayableVideo(a)) videos.push(a);
            else if (pickImageUrl(a) !== null) images.push(a);
          }
          if (batch.length < 100) break; // catalog exhausted
        }
      } catch {
        /* leave what we found */
      }
      if (alive) {
        // Videos lead (they're the newest medium), then images fill the walls.
        // Apps don't take wall slots — they stand on the floor as arcade cabinets.
        setWorks([...videos.slice(0, maxVideos), ...images].slice(0, want));
        setApps(appWorks.slice(0, maxApps));
        setTotal(tot);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [slug, want, maxVideos, maxApps]);
  return { works, apps, total, loading };
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
          <Text position={[0, 0.055, 0.01]} fontSize={0.085} color="#2c2822" font={DISPLAY_FONT} maxWidth={1.05} anchorX="center" anchorY="middle">
            {work.title.length > 26 ? work.title.slice(0, 25) + "…" : work.title}
          </Text>
          <Text position={[0, -0.075, 0.01]} fontSize={0.06} color={item.curatedBy ? accent : "#77705f"} font={DISPLAY_FONT} maxWidth={1.05} anchorX="center" anchorY="middle">
            {item.curatedBy ? `curated · by ${item.curatedBy}` : work.artifactType}
          </Text>
        </Suspense>
      </group>
    </group>
  );
}

/**
 * A wall-hung VIDEO work — plays in place like a living painting.
 * Muted + looped so browsers allow autoplay; unmutes while you hover it.
 * If the stream can't load, falls back to hanging its thumbnail still.
 */
function VideoFrame({
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
  const [tex, setTex] = useState<THREE.VideoTexture | null>(null);
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const url = work.publicUrl;
    if (!url) {
      setFailed(true);
      return;
    }
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = url;
    let alive = true;
    v.addEventListener("canplay", () => {
      if (!alive) return;
      const t = new THREE.VideoTexture(v);
      t.colorSpace = THREE.SRGBColorSpace;
      videoRef.current = v;
      setTex(t);
      v.play().catch(() => {});
    });
    v.addEventListener("error", () => alive && setFailed(true));
    return () => {
      alive = false;
      try {
        v.pause();
        v.src = "";
        v.load();
      } catch {
        /* noop */
      }
    };
  }, [work]);

  // Failed stream → hang the thumbnail still instead (or nothing).
  if (failed) {
    return pickImageUrl(work) ? (
      <ArtworkFrame item={item} position={position} rotation={rotation} accent={accent} onOpen={onOpen} onHover={onHover} />
    ) : null;
  }
  if (!tex) return null;

  const w = 2.6; // cinema-widescreen hang
  const h = 1.5;

  return (
    <group
      position={position}
      rotation={rotation}
      onClick={(e) => {
        if (((e as unknown as { delta?: number }).delta ?? 0) > 5) return;
        e.stopPropagation?.();
        onOpen(work);
      }}
      onPointerOver={(e) => {
        e.stopPropagation?.();
        onHover(work);
        document.body.style.cursor = "pointer";
        // Sound while you stand in front of it.
        if (videoRef.current) {
          videoRef.current.muted = false;
          videoRef.current.play().catch(() => {});
        }
      }}
      onPointerOut={() => {
        onHover(null);
        document.body.style.cursor = "auto";
        if (videoRef.current) videoRef.current.muted = true;
      }}
    >
      {/* Slim dark cinema frame */}
      <mesh position={[0, 0, -0.045]} castShadow>
        <boxGeometry args={[w + 0.18, h + 0.18, 0.07]} />
        <meshStandardMaterial color="#17181a" roughness={0.5} metalness={0.3} />
      </mesh>
      {/* The moving picture */}
      <mesh>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
      {/* Placard */}
      <group position={[0, -(h / 2) - 0.32, 0]}>
        <mesh>
          <planeGeometry args={[1.15, 0.3]} />
          <meshStandardMaterial color="#faf7f0" roughness={0.85} />
        </mesh>
        <Suspense fallback={null}>
          <Text position={[0, 0.055, 0.01]} fontSize={0.085} color="#2c2822" font={DISPLAY_FONT} maxWidth={1.05} anchorX="center" anchorY="middle">
            {work.title.length > 26 ? work.title.slice(0, 25) + "…" : work.title}
          </Text>
          <Text position={[0, -0.075, 0.01]} fontSize={0.06} color={accent} font={DISPLAY_FONT} maxWidth={1.05} anchorX="center" anchorY="middle">
            ▶ video · hover for sound
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

/**
 * The checkout desk — the counter you walk up to, and the clerk behind it.
 *
 * Geometry modelled on the Joinery's sales desk (`furniture-hall.tsx`), because
 * a city where two shops build a counter two different ways is a city that
 * looks assembled. It is NOT the same component, and deliberately: the Joinery
 * trades in play_credit through `POST /joinery/buy` and this counter charges a
 * real card through `/api/commerce`. Two economies that look alike must not
 * share a component, or the day one of them changes hands the other follows
 * without anybody deciding that. The third desk is the one to extract.
 *
 * Nothing here holds a price or a card. The desk's whole job is to be visible,
 * to be solid, and to say when the visitor is close enough to be served; the
 * money is in `<PurchasePanel>`, which is plain DOM outside the `<Canvas>`.
 */
function CheckoutDesk({
  position,
  accent,
  product,
  promptLabel,
  onRangeChange,
  near,
  active,
  onOpen,
}: {
  position: [number, number, number];
  accent: string;
  /** The one thing on sale here, or null when this shop prints nothing. */
  product: PhysicalProduct | null;
  promptLabel: string;
  onRangeChange: (inRange: boolean) => void;
  /** True while the visitor is close enough to be served. */
  near: boolean;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <group
      position={position}
      // No `rotation`. See DESK_OBSTACLE: the collision box has no rotation
      // term, so the desk is square to the room and its box is honest.
      onClick={(e: { stopPropagation?: () => void; delta?: number }) => {
        // A look-drag that happened to end on the counter is not a click. The
        // door and the video frames already guard this; a drag that opened a
        // payment panel would be worse than either.
        if ((e.delta ?? 0) > 5) return;
        // Same proximity rule as the E key. A raycast has no distance limit, so
        // without this the counter is clickable from the far end of the
        // gallery — and the walk-away effect cannot undo it, because that only
        // fires when `deskNear` CHANGES and it was already false.
        if (!near) return;
        e.stopPropagation?.();
        onOpen();
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "auto")}
    >
      {/* Counter body and top */}
      <mesh position={[0, 0.55, 0]} castShadow>
        <boxGeometry args={[3.0, 1.1, 0.9]} />
        <meshStandardMaterial color="#4a3521" roughness={0.55} />
      </mesh>
      <mesh position={[0, 1.14, 0]}>
        <boxGeometry args={[3.2, 0.08, 1.05]} />
        <meshStandardMaterial color="#5c4530" roughness={0.4} />
      </mesh>

      {/* The clerk, behind the counter and facing the doors.
          Addressable only when there is something to sell. A prompt that opens
          a panel with no product in it would be the desk promising a purchase
          the shop cannot make; a shop that prints nothing keeps the attendant
          it has always had, standing where an attendant belongs. */}
      {product ? (
        <TalkableNpc
          position={[0, 0, -1.1]}
          rotation={Math.PI}
          color={accent}
          seed={7}
          name="Checkout"
          promptLabel={promptLabel}
          onRangeChange={onRangeChange}
          active={active}
        />
      ) : (
        <group position={[0, 0, -1.1]} rotation={[0, Math.PI, 0]}>
          <NpcFigure color={accent} seed={7} />
        </group>
      )}

      {/* The board over the counter. The TITLE is here and the PRICE is not:
          a price belongs where it re-renders when a fresh quote moves it, and
          that is the DOM prompt beside the panel. */}
      <mesh position={[0, 1.85, -0.1]} rotation={[-0.18, 0, 0]}>
        <boxGeometry args={[2.6, 0.55, 0.06]} />
        <meshStandardMaterial color="#f2ede2" roughness={0.9} />
      </mesh>
      <Suspense fallback={null}>
        <Text
          position={[0, 1.95, -0.02]}
          rotation={[-0.18, 0, 0]}
          fontSize={0.11}
          color="#3a332c"
          font={DISPLAY_FONT}
          anchorX="center"
          anchorY="middle"
          maxWidth={2.4}
          textAlign="center"
        >
          {product ? `CHECKOUT\n${product.title.slice(0, 40)}` : "CHECKOUT\nNO PRINTS FROM THIS SHOP YET"}
        </Text>
      </Suspense>
    </group>
  );
}

export default function StoreInterior() {
  const { slug } = useParams<{ slug: string }>();
  const [, navigate] = useLocation();
  const [hovered, setHovered] = useState<Artifact | null>(null);

  const { data: landing } = useGetAgentStorefront(slug, {
    query: { queryKey: getGetAgentStorefrontQueryKey(slug), retry: false },
  });
  const { works: imageWorks, apps, total, loading: isLoading } = useWallWorks(slug, MAX_WALL_WORKS);
  const { data: listingsResp } = useGetAgentStorefrontListings(slug, {
    query: { queryKey: getGetAgentStorefrontListingsQueryKey(slug), retry: false },
  });

  const name = landing?.settings.displayName || landing?.agent.displayName || slug;
  const accent = landing?.settings.accentColor || "#8a6b3f";

  // The walls: the owner's own image works first, then curated pieces —
  // IMAGES ONLY. Anything without a displayable image stays in the list view.
  const wallItems: WallItem[] = useMemo(() => {
    const own: WallItem[] = imageWorks.map((w) => ({ work: w, curatedBy: null }));
    const curated: WallItem[] = (listingsResp?.listings ?? []).map((l) => ({
      work: l.artifact,
      curatedBy: l.artifact.creatorName ?? "another agent",
    }));
    const seen = new Set(own.map((i) => i.work.id));
    return [...own, ...curated.filter((i) => !seen.has(i.work.id))]
      .filter((i) => pickImageUrl(i.work) !== null || isPlayableVideo(i.work))
      .slice(0, MAX_WALL_WORKS);
  }, [imageWorks, listingsResp]);

  const curatedCount = listingsResp?.listings?.length ?? 0;
  const slots = useMemo(() => wallSlots(wallItems.length), [wallItems.length]);

  const openWork = (w: Artifact) => navigate(`/s/${slug}/artifacts/${w.id}`);

  // Step up to a cabinet: the game takes over the screen in an arcade-chrome
  // overlay (the apps are self-contained HTML — they run right here). Esc or
  // STEP AWAY returns you to the store; keyboard goes to the game while open.
  // Declared before the desk because the desk's E handler stands down while a
  // game owns the screen.
  const [playing, setPlaying] = useState<PlayableApp | null>(null);
  useEffect(() => {
    if (!playing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") setPlaying(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing]);

  // ── The checkout desk ──────────────────────────────────────────────────

  const { purchasing } = useAuth();

  /**
   * The artifacts the desk could be selling prints of: the ones actually hung.
   *
   * `commerce_products` is keyed on an artifact, and there is no "products for
   * this shop" endpoint — `GET /commerce/products/for-artifact/:id` is the only
   * read there is. The walls are the right bound anyway: what is on display is
   * what the clerk sells, and a print of a piece that is not in the room would
   * be a thing the shop offers with nothing to point at.
   */
  const wallArtifactIds = useMemo(
    () => wallItems.map((it) => Number(it.work.id)).filter((id) => Number.isInteger(id) && id > 0),
    [wallItems],
  );

  /**
   * What this shop can print, in the order the works hang.
   *
   * One batch when the walls settle, and one only. A failed probe resolves to
   * "this piece has no print" rather than rejecting the batch: a single 500 on
   * one artifact must not empty a counter that has something to sell, and
   * `fetchPhysicalProducts` already turns the interesting failure — a 404,
   * which is what the whole surface answers with commerce switched off — into
   * an empty list.
   */
  const { data: deskProducts } = useQuery({
    queryKey: ["commerce", "store-products", slug, wallArtifactIds],
    queryFn: async () => {
      const perArtifact = await Promise.all(
        wallArtifactIds.map((id) => fetchPhysicalProducts(id).catch(() => [] as PhysicalProduct[])),
      );
      return perArtifact.flat();
    },
    enabled: wallArtifactIds.length > 0,
    retry: false,
    /**
     * Never yank the counter out from under an open purchase.
     *
     * The app uses a bare `new QueryClient()`, so `refetchOnWindowFocus` is on
     * and `staleTime` is 0 — and returning to this tab is precisely what a 3D
     * Secure challenge and a trip to the settings tab both end with. Every
     * probe is wrapped in `.catch(() => [])`, so one transient blip on the
     * refetch resolves to an empty list, `deskProduct` becomes null and the
     * panel mounted under it unmounts mid-charge.
     *
     * `keepPreviousData` covers the same window for a change of query KEY: the
     * key carries `wallArtifactIds`, which moves whenever the walls resettle.
     */
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });

  /**
   * The one SKU on the counter.
   *
   * v0.1 is one product, quantity one — variants and a cart are explicitly not
   * being built — so the desk offers the first print of the first hung work
   * that has one (the server orders an artifact's products cheapest first). A
   * shop with two prints sells both from the 2D page, which is the surface with
   * room for a list and the one a keyboard can reach.
   */
  const deskProduct = deskProducts?.[0] ?? null;

  const [deskNear, setDeskNear] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  /**
   * True from the moment the panel touches the network until it stops.
   *
   * Drives the rig's `suspended` prop and the backdrop below. The panel reports
   * a superset of "a charge is in flight" on purpose — standing still for the
   * extra half second a quote takes costs nothing, and a rig that resumed
   * between two steps of one purchase would be the bug this exists to prevent.
   */
  const [paymentBusy, setPaymentBusy] = useState(false);

  /**
   * No panel on screen, no suspension. The second lock on the soft-lock.
   *
   * `paymentBusy` is otherwise written only by the panel's `onBusyChange`, so
   * any path that unmounts the panel while it is true strands the rig
   * `suspended` and the E handler dead with no way back but a reload. The
   * panel now releases it on unmount itself; this holds even if some future
   * caller forgets, because the condition is read from what is RENDERED rather
   * than from the panel's cooperation.
   */
  useEffect(() => {
    if (!(deskProduct && panelOpen)) setPaymentBusy(false);
  }, [deskProduct, panelOpen]);

  const buyable = purchasing?.state === "ready" || purchasing?.state === "card_expiring";
  // The verb over the clerk's head. The server's derived state decides it and
  // this page never computes one: an account that has to fix something is
  // offered a checkout to fix it in, and only a ready account is promised a buy.
  const promptLabel = buyable ? "[ E ] BUY" : "[ E ] CHECKOUT";

  // E at the desk, in the city's one grammar for it. Same as the Joinery's:
  // window keydown, typing wins, proximity gates it, and the browser's own
  // meaning for the key is suppressed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget()) return;
      // Never while money is moving. The panel is waiting on a bank or a poll,
      // and E is a toggle — closing it would drop the reference that is the
      // only thing keeping one press of Buy to one charge. Never over a game
      // either: the arcade overlay owns the screen while it is up.
      if (paymentBusy || playing) return;
      if (e.code === "KeyE" && deskNear) {
        e.preventDefault();
        setPanelOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deskNear, paymentBusy, playing]);
  // Walk away and the counter is behind you. A panel left hanging over the far
  // end of the gallery is the thing that makes an overlay feel stuck to the
  // screen rather than attached to the desk.
  // `panelOpen` is a dependency as well as `deskNear`: keyed on the range alone
  // this only fires when the range CHANGES, so a panel opened while already far
  // away would never be closed by it.
  useEffect(() => {
    if (!deskNear) setPanelOpen(false);
  }, [deskNear, panelOpen]);

  // Coming back from sign-in: `?at=desk` puts the visitor where they were.
  const [spawn, setSpawn] = useState<FpsSpawn | null>(null);
  useEffect(() => {
    if (spawn) return; // consume once
    if (new URLSearchParams(window.location.search).get("at") !== "desk") return;
    setSpawn(DESK_SPAWN);
  }, [spawn]);

  // Solid things now depend on the data — the arcade row only exists if this
  // shop has apps — so the list is built per render count rather than frozen
  // at module scope.
  const obstacles = useMemo(() => storeObstacles(apps.length), [apps.length]);

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
              : `${total} work${total === 1 ? "" : "s"}${curatedCount ? ` · ${curatedCount} curated` : ""} · ${wallItems.length} on the walls${apps.length ? ` · ${apps.length} arcade` : ""}`}
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
        WASD to walk · Drag to look · Click a piece{deskProduct ? " · E at the desk to buy" : ""} · EXIT door
        to leave
      </div>

      <Canvas
        className="!absolute inset-0"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        camera={{ position: [0, 2.2, 5.5], fov: 62 }}
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

        {/* First-person: drag looks from where you stand, WASD walks.
            `suspended` is the whole answer to a bank challenge in a WebGL
            view: Stripe renders 3D Secure in a cross-origin iframe over this
            canvas, and a player typing a one-time passcode must not strafe
            across the shop while doing it. */}
        <FirstPersonRig
          eyeHeight={2.2}
          speed={8}
          bounds={{ minX: -8.8, maxX: 8.8, minZ: -13.8, maxZ: 8.6, minY: 1.7, maxY: 6.8 }}
          obstacles={obstacles}
          spawn={spawn}
          suspended={paymentBusy}
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
        {/* THE WAY OUT — glass doors in the entry opening with a lit EXIT
            sign. Click anywhere on it to step back onto the street. */}
        <group
          onClick={(e) => {
            // A look-drag ending on the door is not a click.
            if (((e as unknown as { delta?: number }).delta ?? 0) > 5) return;
            e.stopPropagation?.();
            // Land just outside THIS store's door, not at the district gate.
            navigate(`/city?from=${encodeURIComponent(slug)}`);
          }}
          onPointerOver={() => (document.body.style.cursor = "pointer")}
          onPointerOut={() => (document.body.style.cursor = "auto")}
        >
          {/* Daylight through the glass */}
          <mesh position={[0, 2.5, 9.45]} rotation={[0, Math.PI, 0]}>
            <planeGeometry args={[5.9, 5]} />
            <meshStandardMaterial color="#dfe8ee" emissive="#cfdde8" emissiveIntensity={0.55} />
          </mesh>
          {/* Door frame + double glass doors */}
          {[-1.5, 1.5].map((x) => (
            <group key={x} position={[x, 0, 9.35]}>
              <mesh position={[0, 2.2, 0]} rotation={[0, Math.PI, 0]}>
                <planeGeometry args={[2.6, 4.4]} />
                <meshPhysicalMaterial color="#9fb4bd" transparent opacity={0.32} roughness={0.08} metalness={0.1} side={THREE.DoubleSide} />
              </mesh>
              <mesh position={[x < 0 ? 1.25 : -1.25, 2.2, 0]}>
                <boxGeometry args={[0.1, 4.4, 0.08]} />
                <meshStandardMaterial color="#33302b" metalness={0.5} roughness={0.5} />
              </mesh>
              {/* Push bar */}
              <mesh position={[x < 0 ? 0.9 : -0.9, 2.05, -0.08]} rotation={[0, 0, Math.PI / 2]}>
                <cylinderGeometry args={[0.035, 0.035, 1.0, 8]} />
                <meshStandardMaterial color="#b8b3a8" metalness={0.8} roughness={0.3} />
              </mesh>
            </group>
          ))}
          <mesh position={[0, 4.5, 9.35]}>
            <boxGeometry args={[6.1, 0.16, 0.14]} />
            <meshStandardMaterial color="#2c2a26" metalness={0.5} roughness={0.5} />
          </mesh>
          {/* Lit EXIT sign over the doors */}
          <mesh position={[0, 4.95, 9.3]}>
            <boxGeometry args={[1.5, 0.55, 0.16]} />
            <meshStandardMaterial color="#132015" emissive="#0d3818" emissiveIntensity={0.8} />
          </mesh>
          <Suspense fallback={null}>
            <Text position={[0, 4.95, 9.2]} rotation={[0, Math.PI, 0]} fontSize={0.34} color="#6dff8f" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.18}>
              EXIT
            </Text>
            <Text position={[0, 1.15, 9.25]} rotation={[0, Math.PI, 0]} fontSize={0.16} color="#4a443a" font={DISPLAY_FONT} anchorX="center" anchorY="middle">
              click to return to the street
            </Text>
          </Suspense>
        </group>

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
          <Text position={[0, 6.3, -14.42]} fontSize={0.62} color="#4a443a" font={DISPLAY_FONT} anchorX="center" anchorY="middle" maxWidth={17}>
            {name.toUpperCase()}
          </Text>
        </Suspense>

        {/* Furniture + greenery. The benches are drawn from the same list the
            rig collides against, so a bench that moves takes its box with it. */}
        {BENCH_POSITIONS.map((p) => (
          <GalleryBench key={`${p[0]}-${p[2]}`} position={p} />
        ))}
        {PLANT_POSITIONS.map((p) => (
          <PottedPlant key={`${p[0]}-${p[2]}`} position={p} />
        ))}

        {/* The counter, in line of sight from the doors. The attendant who used
            to stand loose by the entrance is the clerk behind it. */}
        <CheckoutDesk
          position={DESK_POSITION}
          accent={accent}
          product={deskProduct}
          promptLabel={promptLabel}
          onRangeChange={setDeskNear}
          near={deskNear}
          active={panelOpen}
          onOpen={() => setPanelOpen(true)}
        />

        {/* The arcade corner — the store's live apps as playable cabinets,
            lined up along the front wall flanking the entrance. Clicking one
            starts the game right here (overlay), not the artifact page. */}
        {/* Drawn from the same slot list the collision pass reads, and capped
            by it: a cabinet with no slot would be a machine standing where
            nothing is solid. */}
        {apps.slice(0, ARCADE_SLOT_X.length).map((a, i) => (
          <ArcadeCabinet
            key={a.id}
            app={{ id: Number(a.id), title: a.title, creatorName: a.creatorName ?? null, thumbnailUrl: a.thumbnailUrl ?? null }}
            position={[ARCADE_SLOT_X[i]!, 0, ARCADE_Z]}
            rotation={Math.PI}
            seed={i}
            onPlay={(w) => setPlaying(w)}
          />
        ))}
        {apps.length > 0 && (
          <pointLight position={[apps.length > 2 ? 0 : -6.3, 3.4, 7.2]} intensity={14} distance={10} color="#ffd9ac" />
        )}

        {/* The works — images and playing videos, honestly proportioned */}
        {wallItems.map((it, i) =>
          slots[i] ? (
            isPlayableVideo(it.work) ? (
              <VideoFrame
                key={`${it.work.id}-v`}
                item={it}
                position={slots[i].pos}
                rotation={slots[i].rot}
                accent={accent}
                onOpen={openWork}
                onHover={setHovered}
              />
            ) : (
              <ArtworkFrame
                key={`${it.work.id}-${it.curatedBy ? "c" : "o"}`}
                item={it}
                position={slots[i].pos}
                rotation={slots[i].rot}
                accent={accent}
                onOpen={openWork}
                onHover={setHovered}
              />
            )
          ) : null,
        )}

        {isLoading || wallItems.length > 0 ? null : (
          <Suspense fallback={null}>
            <Text position={[0, 3.3, -13]} fontSize={0.4} color="#6b6459" font={DISPLAY_FONT} anchorX="center" maxWidth={14} textAlign="center">
              No image works to hang yet — audio & text live in the list view.
            </Text>
          </Suspense>
        )}
      </Canvas>

      {/* The desk's own prompt, and the PRICE.
          In the DOM rather than in the sprite over the clerk's head: the sprite
          is a canvas texture painted when its words change, which is right for
          a verb and wrong for a number that a fresh quote can move. Here it is
          ordinary text that re-renders, can be read aloud, and can be selected. */}
      {deskProduct && deskNear && !panelOpen && !playing && (
        <div
          className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 pointer-events-none kax3d-hud px-4 py-2 text-center"
          data-testid="text-desk-prompt"
        >
          <p className="text-[11px] uppercase tracking-[0.3em] text-primary font-bold">
            {promptLabel} — {formatMoney(deskProduct.totalCents, deskProduct.currency)}
          </p>
          <p className="text-[9px] uppercase tracking-widest text-muted-foreground mt-1">
            {deskProduct.title}
          </p>
        </div>
      )}

      {/* The purchase itself — plain DOM, OUTSIDE the Canvas, a sibling to the
          arcade overlay. The same component the 2D artifact page mounts: the
          desk is a second door into one flow, never a second flow.

          The player does not leave this route at any point. `newTab` sends the
          settings and orders links to a new tab so the room survives the trip,
          and the panel re-reads the account on `visibilitychange` and `focus`
          so tabbing back turns Checkout into Buy without a reload. */}
      {deskProduct && panelOpen && (
        <>
          {/* While money is moving: a shield over the scene. The rig is already
              suspended, so this is not what stops the avatar — it is what stops
              a click meant for a bank's iframe landing on a painting behind it,
              and what makes the room read as having stepped back. */}
          {paymentBusy && (
            <div className="absolute inset-0 z-30 bg-black/80" aria-hidden="true" data-testid="overlay-payment-shield" />
          )}
          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-40 w-[min(30rem,92vw)]">
            <PurchasePanel
              product={deskProduct}
              signInReturnTo={`/s/${slug}/room?at=desk`}
              onBusyChange={setPaymentBusy}
              onClose={() => setPanelOpen(false)}
              newTab
              className="kax3d-hud"
            />
          </div>
        </>
      )}

      {/* Click a cabinet → the game plays right here via the frame proxy. */}
      {playing && (
        <PlayOverlay
          app={playing}
          onClose={() => setPlaying(null)}
          onArtifact={(a) => navigate(`/s/${slug}/artifacts/${a.id}`)}
        />
      )}
    </div>
  );
}
