import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import * as THREE from "three";

const SPACE_MONO_WOFF = "https://fonts.gstatic.com/s/spacemono/v12/i7dPIFZifjKcF5UAWdDRYEF8RQ.woff";

/** The minimum an arcade machine needs to know about its game. */
export interface PlayableApp {
  id: number;
  title: string;
  creatorName?: string | null;
  thumbnailUrl?: string | null;
}

// Classic cabinet liveries — marquee glow + side-art color, seeded per app.
const CABINET_LIVERIES = [
  { glow: "#ffd23e", side: "#8c2f2a" }, // amber marquee, red sides
  { glow: "#6de1ff", side: "#1d3a5f" }, // ice blue
  { glow: "#ff6ec7", side: "#3d1f4e" }, // magenta
  { glow: "#7dff8a", side: "#1e4a2a" }, // phosphor green
];

/**
 * An upright arcade cabinet: backlit marquee with the title, tilted CRT
 * running an attract mode (INSERT COIN blinking, or the app's thumbnail
 * behind scanlines), joystick + buttons, coin door. Click to play.
 */
export function ArcadeCabinet({
  app,
  position,
  rotation,
  seed,
  onPlay,
  onHover,
}: {
  app: PlayableApp;
  position: [number, number, number];
  rotation: number;
  seed: number;
  onPlay: (a: PlayableApp) => void;
  onHover?: (a: PlayableApp | null) => void;
}) {
  const livery = CABINET_LIVERIES[seed % CABINET_LIVERIES.length];
  const [thumb, setThumb] = useState<HTMLImageElement | null>(null);
  const blink = useRef(0);

  const [, ctx, tex] = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 200;
    const cx = c.getContext("2d")!;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return [c, cx, t] as const;
  }, []);

  useEffect(() => {
    const url = app.thumbnailUrl;
    if (!url || url.startsWith("inline:")) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => setThumb(img);
    img.src = url;
  }, [app]);

  // CRT attract mode, redrawn at ~1.6 Hz for the INSERT COIN blink.
  useFrame((s) => {
    if (s.clock.elapsedTime - blink.current < 0.6) return;
    blink.current = s.clock.elapsedTime;
    const on = Math.floor(s.clock.elapsedTime / 0.6) % 2 === 0;
    ctx.fillStyle = "#050507";
    ctx.fillRect(0, 0, 256, 200);
    if (thumb) {
      const ar = thumb.width / thumb.height;
      const tw = ar > 256 / 150 ? 150 * ar : 256;
      const th = ar > 256 / 150 ? 150 : 256 / ar;
      ctx.drawImage(thumb, (256 - tw) / 2, 14 + (150 - th) / 2, tw, th);
    } else {
      let h = (seed + 1) * 2654435761;
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
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(0, 0, 256, 14);
    ctx.font = "bold 11px monospace";
    ctx.fillStyle = livery.glow;
    ctx.fillText(app.title.slice(0, 34).toUpperCase(), 6, 11);
    if (on) {
      ctx.font = "bold 16px monospace";
      ctx.fillStyle = "#ffffff";
      ctx.fillText("INSERT COIN", 76, 180);
    }
    ctx.font = "10px monospace";
    ctx.fillStyle = "#8fa0ad";
    ctx.fillText("1UP  00", 10, 196);
    ctx.fillText("HI  51137", 180, 196);
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
        onPlay(app);
      }}
      onPointerOver={(e) => {
        e.stopPropagation?.();
        onHover?.(app);
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        onHover?.(null);
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
      {/* Body + side art */}
      <mesh position={[0, 1.02, -0.02]} castShadow>
        <boxGeometry args={[0.76, 0.94, 0.8]} />
        <meshStandardMaterial color={body} roughness={0.6} />
      </mesh>
      {[-0.395, 0.395].map((x) => (
        <mesh key={x} position={[x, 1.05, -0.02]}>
          <boxGeometry args={[0.025, 1.62, 0.82]} />
          <meshStandardMaterial color={livery.side} roughness={0.55} />
        </mesh>
      ))}
      {/* Control deck */}
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
      {/* CRT */}
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
      {/* Marquee */}
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
            {app.title.length > 20 ? app.title.slice(0, 19) + "…" : app.title.toUpperCase()}
          </Text>
        </Suspense>
      </group>
      {/* Cap + creator plate */}
      <mesh position={[0, 2.24, -0.05]}>
        <boxGeometry args={[0.8, 0.06, 0.7]} />
        <meshStandardMaterial color={body} roughness={0.6} />
      </mesh>
      {app.creatorName && (
        <Suspense fallback={null}>
          <Text position={[0, 0.62, 0.44]} fontSize={0.05} color="#8f8468" font={SPACE_MONO_WOFF} anchorX="center" anchorY="middle">
            {`by ${app.creatorName}`.slice(0, 28)}
          </Text>
        </Suspense>
      )}
    </group>
  );
}

/**
 * The machine, playing: arcade-chrome overlay running the game through the
 * server-side frame proxy (`/api/arcade/frame/:id`), which re-serves the
 * self-contained HTML same-origin with headers a browser will actually
 * execute — object storage ships it as text/plain + a deny-all CSP, which is
 * why direct embedding showed a black screen. Esc or STEP AWAY closes.
 */
export function PlayOverlay({
  app,
  onClose,
  onArtifact,
}: {
  app: PlayableApp;
  onClose: () => void;
  onArtifact?: (a: PlayableApp) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const frameSrc = `/api/arcade/frame/${app.id}`;

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-black/95" data-testid="arcade-overlay">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#3a2f14]" style={{ background: "linear-gradient(180deg,#1a1408,#0c0a04)" }}>
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-[#ffd23e] text-lg" aria-hidden>◉</span>
          <span className="text-[#ffd23e] font-bold uppercase tracking-[0.25em] truncate" style={{ textShadow: "0 0 12px rgba(255,210,62,0.6)" }}>
            {app.title}
          </span>
          <span className="hidden sm:inline text-[9px] uppercase tracking-[0.3em] text-[#8f8468]">
            {app.creatorName ? `by ${app.creatorName} · ` : ""}insert coin · free play
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a
            href={frameSrc}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] uppercase tracking-widest text-[#8f8468] hover:text-[#ffd23e] border border-[#3a2f14] px-3 py-1.5"
          >
            Full screen ↗
          </a>
          {onArtifact && (
            <button
              onClick={() => onArtifact(app)}
              className="text-[10px] uppercase tracking-widest text-[#8f8468] hover:text-[#ffd23e] border border-[#3a2f14] px-3 py-1.5"
            >
              Artifact
            </button>
          )}
          <button
            onClick={onClose}
            className="text-[10px] uppercase tracking-widest text-black font-bold bg-[#ffd23e] hover:bg-[#ffe27a] px-3 py-1.5"
            data-testid="button-step-away"
          >
            ✕ Step away
          </button>
        </div>
      </div>
      <iframe
        src={frameSrc}
        title={app.title}
        className="flex-1 w-full border-0 bg-black"
        sandbox="allow-scripts allow-pointer-lock"
        allow="autoplay; fullscreen; gamepad"
      />
      <div className="px-4 py-1.5 text-center text-[9px] uppercase tracking-[0.4em] text-[#5c543f] border-t border-[#3a2f14]">
        esc to step away · click inside the screen to give the game your keyboard
      </div>
    </div>
  );
}
