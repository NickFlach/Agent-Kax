import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import * as THREE from "three";
import { useParams, useLocation, Link } from "wouter";
import {
  useGetAgentStorefront,
  useGetAgentStorefrontListings,
  getGetAgentStorefrontQueryKey,
  getGetAgentStorefrontListingsQueryKey,
} from "@workspace/api-client-react";
import type { Artifact } from "@workspace/api-client-react";

type WallItem = { work: Artifact; curatedBy: string | null };
import { Button } from "@/components/ui/button";
import { FirstPersonRig } from "@/components/first-person-rig";
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
          <Text position={[0, 0.055, 0.01]} fontSize={0.085} color="#2c2822" font={SPACE_MONO_WOFF} maxWidth={1.05} anchorX="center" anchorY="middle">
            {work.title.length > 26 ? work.title.slice(0, 25) + "…" : work.title}
          </Text>
          <Text position={[0, -0.075, 0.01]} fontSize={0.06} color={accent} font={SPACE_MONO_WOFF} maxWidth={1.05} anchorX="center" anchorY="middle">
            ▶ video · hover for sound
          </Text>
        </Suspense>
      </group>
    </group>
  );
}

// Classic cabinet liveries — marquee glow + side-art color, seeded per app.
const CABINET_LIVERIES = [
  { glow: "#ffd23e", side: "#8c2f2a" }, // amber marquee, red sides
  { glow: "#6de1ff", side: "#1d3a5f" }, // ice blue
  { glow: "#ff6ec7", side: "#3d1f4e" }, // magenta
  { glow: "#7dff8a", side: "#1e4a2a" }, // phosphor green
];

/**
 * An APP work as an old-school upright arcade cabinet: backlit marquee with
 * the title, tilted CRT running an attract mode (INSERT COIN blinking, or the
 * app's thumbnail behind scanlines), joystick + buttons, coin door. Click the
 * cabinet to open the app's page and play.
 */
function ArcadeCabinet({
  work,
  position,
  rotation,
  seed,
  onOpen,
  onHover,
}: {
  work: Artifact;
  position: [number, number, number];
  rotation: number;
  seed: number;
  onOpen: (w: Artifact) => void;
  onHover: (w: Artifact | null) => void;
}) {
  const livery = CABINET_LIVERIES[seed % CABINET_LIVERIES.length];
  const [thumb, setThumb] = useState<HTMLImageElement | null>(null);
  const blink = useRef(0);

  const [canvas, ctx, tex] = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 200;
    const cx = c.getContext("2d")!;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return [c, cx, t] as const;
  }, []);

  // Try the app's thumbnail for the screen; fall back to pure attract mode.
  useEffect(() => {
    const url = pickImageUrl(work);
    if (!url) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => setThumb(img);
    img.src = url;
  }, [work]);

  // CRT attract mode, redrawn at ~1.6 Hz for the INSERT COIN blink.
  useFrame((s) => {
    if (s.clock.elapsedTime - blink.current < 0.6) return;
    blink.current = s.clock.elapsedTime;
    const on = Math.floor(s.clock.elapsedTime / 0.6) % 2 === 0;
    ctx.fillStyle = "#050507";
    ctx.fillRect(0, 0, 256, 200);
    if (thumb) {
      // Cover-fit the thumbnail, then rake scanlines over it.
      const ar = thumb.width / thumb.height;
      const tw = ar > 256 / 150 ? 150 * ar : 256;
      const th = ar > 256 / 150 ? 150 : 256 / ar;
      ctx.drawImage(thumb, (256 - tw) / 2, 14 + (150 - th) / 2, tw, th);
    } else {
      // Pixel-invader rows, seeded so each cabinet has its own creatures.
      let h = seed * 2654435761;
      const rnd = () => {
        h = (h * 1664525 + 1013904223) >>> 0;
        return h / 4294967296;
      };
      ctx.fillStyle = livery.glow;
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 6; col++) {
          const bx = 28 + col * 36;
          const by = 34 + row * 30;
          for (let px = 0; px < 5; px++) {
            for (let py = 0; py < 4; py++) {
              if (rnd() > 0.45) ctx.fillRect(bx + px * 4, by + py * 4, 3, 3);
            }
          }
        }
      }
    }
    // Title strip
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(0, 0, 256, 14);
    ctx.font = "bold 11px monospace";
    ctx.fillStyle = livery.glow;
    ctx.fillText(work.title.slice(0, 34).toUpperCase(), 6, 11);
    // Blinking INSERT COIN + score line
    if (on) {
      ctx.font = "bold 16px monospace";
      ctx.fillStyle = "#ffffff";
      ctx.fillText("INSERT COIN", 76, 180);
    }
    ctx.font = "10px monospace";
    ctx.fillStyle = "#8fa0ad";
    ctx.fillText("1UP  00", 10, 196);
    ctx.fillText("HI  51137", 180, 196);
    // Scanlines
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    for (let y = 0; y < 200; y += 3) ctx.fillRect(0, y, 256, 1);
    tex.needsUpdate = true;
  });

  const body = "#141417";
  return (
    <group
      position={position}
      rotation={[0, rotation, 0]}
      onClick={(e) => {
        if (((e as unknown as { delta?: number }).delta ?? 0) > 5) return;
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
      {/* Pedestal + coin door */}
      <mesh position={[0, 0.28, 0]} castShadow>
        <boxGeometry args={[0.8, 0.56, 0.85]} />
        <meshStandardMaterial color={body} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.3, 0.428]}>
        <planeGeometry args={[0.3, 0.24]} />
        <meshStandardMaterial color="#26262b" metalness={0.6} roughness={0.35} />
      </mesh>
      {[-0.06, 0.06].map((x) => (
        <mesh key={x} position={[x, 0.34, 0.433]}>
          <planeGeometry args={[0.05, 0.09]} />
          <meshStandardMaterial color="#b8b3a8" metalness={0.8} roughness={0.3} />
        </mesh>
      ))}
      {/* Body */}
      <mesh position={[0, 1.02, -0.02]} castShadow>
        <boxGeometry args={[0.76, 0.94, 0.8]} />
        <meshStandardMaterial color={body} roughness={0.6} />
      </mesh>
      {/* Side art */}
      {[-0.395, 0.395].map((x) => (
        <mesh key={x} position={[x, 1.05, -0.02]}>
          <boxGeometry args={[0.025, 1.62, 0.82]} />
          <meshStandardMaterial color={livery.side} roughness={0.55} />
        </mesh>
      ))}
      {/* Control deck: joystick + buttons */}
      <group position={[0, 1.28, 0.3]} rotation={[-0.42, 0, 0]}>
        <mesh castShadow>
          <boxGeometry args={[0.76, 0.07, 0.4]} />
          <meshStandardMaterial color="#1d1d21" roughness={0.5} />
        </mesh>
        <mesh position={[-0.18, 0.09, 0.02]}>
          <cylinderGeometry args={[0.016, 0.016, 0.12, 8]} />
          <meshStandardMaterial color="#2b2b2e" metalness={0.6} roughness={0.4} />
        </mesh>
        <mesh position={[-0.18, 0.16, 0.02]}>
          <sphereGeometry args={[0.038, 12, 10]} />
          <meshStandardMaterial color="#c62828" roughness={0.35} />
        </mesh>
        {[0.06, 0.17, 0.28].map((x, i) => (
          <mesh key={x} position={[x, 0.045, 0.04]}>
            <cylinderGeometry args={[0.032, 0.032, 0.025, 12]} />
            <meshStandardMaterial
              color={["#c62828", "#f9a825", "#f5f0e6"][i]}
              emissive={["#c62828", "#f9a825", "#f5f0e6"][i]}
              emissiveIntensity={0.25}
              roughness={0.4}
            />
          </mesh>
        ))}
      </group>
      {/* CRT: bezel + attract screen, tilted back like the real thing */}
      <group position={[0, 1.62, 0.18]} rotation={[-0.2, 0, 0]}>
        <mesh castShadow>
          <boxGeometry args={[0.68, 0.58, 0.08]} />
          <meshStandardMaterial color="#0c0c0e" roughness={0.45} />
        </mesh>
        <mesh position={[0, 0, 0.045]}>
          <planeGeometry args={[0.57, 0.46]} />
          <meshBasicMaterial map={tex} toneMapped={false} />
        </mesh>
      </group>
      {/* Marquee — backlit title */}
      <group position={[0, 2.06, 0.14]} rotation={[0.18, 0, 0]}>
        <mesh castShadow>
          <boxGeometry args={[0.8, 0.3, 0.12]} />
          <meshStandardMaterial color={body} roughness={0.55} />
        </mesh>
        <mesh position={[0, 0, 0.065]}>
          <planeGeometry args={[0.74, 0.24]} />
          <meshStandardMaterial color={livery.glow} emissive={livery.glow} emissiveIntensity={0.85} toneMapped={false} />
        </mesh>
        <Suspense fallback={null}>
          <Text position={[0, 0, 0.075]} fontSize={0.075} color="#141417" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" maxWidth={0.7} textAlign="center">
            {work.title.length > 20 ? work.title.slice(0, 19) + "…" : work.title.toUpperCase()}
          </Text>
        </Suspense>
      </group>
      {/* Cap */}
      <mesh position={[0, 2.24, -0.05]}>
        <boxGeometry args={[0.8, 0.06, 0.7]} />
        <meshStandardMaterial color={body} roughness={0.6} />
      </mesh>
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
        WASD to walk · Drag to look · Click a piece · EXIT door to leave
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

        {/* First-person: drag looks from where you stand, WASD walks. */}
        <FirstPersonRig
          eyeHeight={2.2}
          speed={8}
          bounds={{ minX: -8.8, maxX: 8.8, minZ: -13.8, maxZ: 8.6, minY: 1.7, maxY: 6.8 }}
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
            <Text position={[0, 4.95, 9.2]} rotation={[0, Math.PI, 0]} fontSize={0.34} color="#6dff8f" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle" letterSpacing={0.18}>
              EXIT
            </Text>
            <Text position={[0, 1.15, 9.25]} rotation={[0, Math.PI, 0]} fontSize={0.16} color="#4a443a" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle">
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

        {/* The arcade corner — the store's live apps as playable cabinets,
            lined up along the front wall flanking the entrance. */}
        {apps.map((a, i) => (
          <ArcadeCabinet
            key={a.id}
            work={a}
            position={[[-7.2, -5.4, 7.2, 5.4][i] ?? -7.2 + i * 1.9, 0, 8.1]}
            rotation={Math.PI}
            seed={i}
            onOpen={openWork}
            onHover={setHovered}
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
            <Text position={[0, 3.3, -13]} fontSize={0.4} color="#6b6459" font={SPACE_MONO_WOFF} anchorX="center" maxWidth={14} textAlign="center">
              No image works to hang yet — audio & text live in the list view.
            </Text>
          </Suspense>
        )}
      </Canvas>
    </div>
  );
}
