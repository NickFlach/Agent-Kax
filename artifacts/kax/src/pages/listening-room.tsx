import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import { Link } from "wouter";
import { FirstPersonRig } from "@/components/first-person-rig";
import { VenuePresence } from "@/components/presence";
import { SpeakControl, useSpeak } from "@/components/speak-control";
import { ChatPane } from "@/components/chat-pane";
import { DISPLAY_FONT } from "@/lib/fonts";
import { preferredAudioSource } from "@/lib/radio-source";

/**
 * THE LISTENING ROOM (#408).
 *
 * Kannaka Radio runs 24/7 and the city had no door to it. This is the door:
 * the live Icecast mount plays in the room (a human gesture starts it, because
 * browsers block autoplay), the marquee shows what's on from the
 * `radio.now_playing` bus mirror, and orations land as room events at their
 * slots. Same presence/speak/chat spine as the other venues, so a `--voice`
 * resident standing here can fold what it hears into conversation — the radio
 * becomes shared context for agents, not just humans.
 */

interface RadioState {
  stream: string;
  nowPlaying: { title: string | null; artist: string | null; kind: string | null; url: string | null; updatedAt: string } | null;
}

const API = (import.meta as { env?: Record<string, string> }).env?.VITE_API_BASE ?? "";

export default function ListeningRoom() {
  const { sayRef, onSay, transcript, you, onTranscript } = useSpeak();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [radio, setRadio] = useState<RadioState>({ stream: "https://radio.ninja-portal.com/stream", nowPlaying: null });
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The continuous /stream mount is ADR-0004 (Proposed) and 400s; until it
  // ships, the reachable source is the current track's own file.
  const src = preferredAudioSource(radio);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch(`${API}/api/city/radio`);
        if (!r.ok || stop) return;
        setRadio((await r.json()) as RadioState);
      } catch { /* the room waits */ }
    };
    void poll();
    const id = setInterval(poll, 10000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) { a.pause(); setPlaying(false); return; }
    if (!src) { setError("Nothing is on air right now — the radio is quiet."); return; }
    setError(null);
    a.play()
      .then(() => { setPlaying(true); setError(null); })
      .catch(() => { setPlaying(false); setError("Couldn't start the stream — it may be offline."); });
  };

  const np = radio.nowPlaying;
  const marquee = useMemo(() => {
    if (!np || (!np.title && !np.artist)) return "KANNAKA RADIO · LIVE";
    const who = np.artist ? `${np.artist} — ` : "";
    const tag = np.kind === "oration" ? " · ORATION" : "";
    return `NOW PLAYING · ${who}${np.title ?? "…"}${tag}`.toUpperCase();
  }, [np]);

  return (
    <div className="relative h-screen w-full bg-[#0b0710] overflow-hidden kax3d-font">
      {/* The live stream. DOM, not Canvas — a human gesture starts it. No
          crossOrigin: the room only plays the audio, and forcing a CORS check
          the radio host does not answer is itself a way to make play() fail. */}
      <audio
        ref={audioRef}
        src={src ?? undefined}
        preload="none"
        onError={() => { if (src) { setPlaying(false); setError("The stream is offline right now."); } }}
      />

      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-4 pointer-events-none">
        <Link href="/city" className="font-bold tracking-[0.3em] uppercase text-primary pointer-events-auto hover:text-primary/80" data-testid="link-back-city">
          ← City
        </Link>
        <button
          onClick={toggle}
          data-testid="button-radio-toggle"
          className="pointer-events-auto text-[11px] font-bold uppercase tracking-[0.3em] px-4 py-2 border border-primary/50 text-primary hover:bg-primary/10"
        >
          {playing ? "❚❚ pause" : "▶ tune in"}
        </button>
      </div>

      <div className="absolute top-16 left-0 p-6 z-10 pointer-events-none">
        <div className="kax3d-hud p-5 rounded-none max-w-md pointer-events-auto">
          <p className="text-[10px] text-accent font-bold uppercase tracking-[0.3em] mb-1">Kannaka Radio</p>
          <h1 className="text-xl font-bold text-foreground tracking-widest uppercase" data-testid="text-listening-title">The Listening Room</h1>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-2 truncate" data-testid="text-now-playing">{marquee}</p>
          {error && (
            <p className="text-[10px] text-destructive uppercase tracking-widest mt-1" data-testid="text-radio-error">{error}</p>
          )}
        </div>
      </div>

      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-[0.4em] text-muted-foreground pointer-events-none z-10 font-bold">
        WASD to walk · Drag to look · tune in to hear the stream
      </div>

      <SpeakControl sayRef={sayRef} testId="input-listening-chat" />
      <ChatPane room="listening" transcript={transcript} you={you} testId="pane-listening-chat" />

      <Canvas
        className="!absolute inset-0"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        camera={{ position: [0, 1.7, 5.5], fov: 62 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
      >
        <color attach="background" args={["#0b0710"]} />
        <ambientLight intensity={0.32} color="#e0b0ff" />
        <hemisphereLight args={["#3a1f4a", "#0b0710", 0.4]} />
        <pointLight position={[0, 3.2, 0]} intensity={18} distance={14} decay={2} color={playing ? "#ff9ad2" : "#7a5a9a"} />
        <pointLight position={[-3, 2.4, -2]} intensity={10} distance={10} decay={2} color="#9a6ad8" />

        <FirstPersonRig eyeHeight={1.7} speed={6} bounds={{ minX: -5.5, maxX: 5.5, minZ: -5.5, maxZ: 5.5, minY: 1.6, maxY: 2.4 }} />
        <VenuePresence room="listening" onSay={onSay} onTranscript={onTranscript} />

        {/* Shell: a warm dark lounge. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
          <planeGeometry args={[13, 13]} />
          <meshStandardMaterial color="#160d1c" roughness={0.85} />
        </mesh>
        <mesh position={[0, 1.9, -6]}>
          <planeGeometry args={[13, 3.8]} />
          <meshStandardMaterial color="#1c1226" roughness={0.9} />
        </mesh>

        {/* The stage — a speaker stack that glows with the music when playing. */}
        {[-2.2, 2.2].map((x) => (
          <mesh key={x} position={[x, 1.1, -5.4]}>
            <boxGeometry args={[1.1, 2.2, 0.7]} />
            <meshStandardMaterial color="#241531" emissive={playing ? "#ff6ab0" : "#2a1a3a"} emissiveIntensity={playing ? 0.6 : 0.15} roughness={0.6} />
          </mesh>
        ))}

        {/* The marquee, on the back wall. */}
        <Suspense fallback={null}>
          <Text position={[0, 2.6, -5.9]} fontSize={0.22} color="#ffb0e0" font={DISPLAY_FONT} anchorX="center" anchorY="middle" maxWidth={11} textAlign="center" letterSpacing={0.08}>
            {marquee}
          </Text>
          <Text position={[0, 0.55, -5.9]} fontSize={0.1} color="#8a6a9a" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.2}>
            {playing ? "ON AIR" : "TUNE IN TO LISTEN"}
          </Text>
        </Suspense>
      </Canvas>
    </div>
  );
}
