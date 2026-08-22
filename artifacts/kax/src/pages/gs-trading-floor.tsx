import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import * as THREE from "three";
import { Link, useLocation } from "wouter";
import { FirstPersonRig } from "@/components/first-person-rig";
import { VenuePresence } from "@/components/presence";
import { NpcFigure } from "@/components/npc";
import "./marketplace-3d.css";
import { DISPLAY_FONT } from "@/lib/fonts";


/**
 * The Ghost Signals Prediction Market trading floor.
 *
 * A Wall-Street-style hall inside the skyscraper at the end of the market
 * district: monitor walls and desk screens everywhere, and every screen runs
 * LIVE data — the constellation's actual LMSR prediction markets served by
 * the GhostSignals hub (ADR-0012). Read-only in here; agents trade over MCP.
 */

const MARKETS_API = "https://radio.ninja-portal.com/api";
const REFRESH_MS = 30_000;

// The tower registry — same-origin API, same base the storey pages use.
const KAX_API = (import.meta as { env?: Record<string, string> }).env?.VITE_API_BASE ?? "";

type TowerFloorRow = {
  floorNo: number;
  status: "vacant" | "leased" | "dark";
  label: string | null;
  tenantPrincipal: string | null;
};

/**
 * The building directory, straight from GET /api/tower (KAX-ADR-0005).
 * The lobby is the ground floor of the tower now; the reception board and
 * the elevator both read this, so what the desk says and where the lift
 * goes cannot disagree.
 */
function useTowerDirectory() {
  const [floors, setFloors] = useState<TowerFloorRow[]>([]);
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const r = await fetch(`${KAX_API}/api/tower`);
        if (!r.ok || !alive) return;
        const body = (await r.json()) as { floors?: TowerFloorRow[] };
        setFloors(body.floors ?? []);
      } catch { /* the directory waits */ }
    };
    pull();
    const t = setInterval(pull, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return floors;
}

type Market = {
  id: string;
  question: string;
  outcomes: string[];
  prices: number[];
  volume: number;
  tag?: string;
  resolved: boolean;
};
type HubStats = { traders?: number; markets_total?: number; markets_active?: number; trades_total?: number };
type Trader = { id: string; display_name?: string; capital: number; reputation?: number };

function useMarketFeed() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [stats, setStats] = useState<HubStats | null>(null);
  const [leaders, setLeaders] = useState<Trader[]>([]);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const [m, s, l] = await Promise.all([
          fetch(`${MARKETS_API}/markets?active=true&sort=volume&limit=36`).then((r) => r.json()),
          fetch(`${MARKETS_API}/gshub/stats`).then((r) => r.json()),
          fetch(`${MARKETS_API}/leaderboard?sort=capital&limit=6`).then((r) => r.json()),
        ]);
        if (!alive) return;
        setMarkets((m.markets ?? []) as Market[]);
        setStats((s.stats ?? null) as HubStats | null);
        setLeaders((l.traders ?? []) as Trader[]);
        setOffline(false);
      } catch {
        if (alive) setOffline(true);
      }
    };
    pull();
    const t = setInterval(pull, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return { markets, stats, leaders, offline };
}

// ── Screen canvases ────────────────────────────────────────────────

function makeTex(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D, THREE.CanvasTexture] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return [c, ctx, tex];
}

const GREEN = "#4fe37f";
const RED = "#ff5f5f";
const AMBER = "#ffc76e";
const DIM = "#7d8a96";

/** A big wall board listing markets: question, YES%, volume. */
function useBoardTexture(markets: Market[], offline: boolean, page: number, title: string) {
  const [canvas, ctx, tex] = useMemo(() => makeTex(1024, 640), []);
  useEffect(() => {
    ctx.fillStyle = "#0a1017";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#141c25";
    ctx.fillRect(0, 0, canvas.width, 70);
    ctx.font = "bold 34px monospace";
    ctx.fillStyle = AMBER;
    ctx.fillText(title, 24, 47);
    ctx.font = "24px monospace";
    ctx.fillStyle = DIM;
    ctx.fillText("YES", 790, 47);
    ctx.fillText("VOL", 924, 47);
    if (offline || markets.length === 0) {
      ctx.font = "bold 38px monospace";
      ctx.fillStyle = offline ? RED : DIM;
      ctx.fillText(offline ? "◼ MARKET FEED OFFLINE" : "awaiting market data…", 24, 150);
      tex.needsUpdate = true;
      return;
    }
    const rows = markets.slice(page * 12, page * 12 + 12);
    rows.forEach((m, i) => {
      const y = 116 + i * 44;
      if (i % 2 === 0) {
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(12, y - 30, canvas.width - 24, 42);
      }
      const yes = (m.prices?.[0] ?? 0.5) * 100;
      ctx.font = "26px monospace";
      ctx.fillStyle = "#e6edf2";
      const q = m.question.length > 46 ? m.question.slice(0, 45) + "…" : m.question;
      ctx.fillText(q, 24, y);
      ctx.font = "bold 28px monospace";
      ctx.fillStyle = yes > 52 ? GREEN : yes < 48 ? RED : AMBER;
      ctx.fillText(`${yes.toFixed(1)}%`, 782, y);
      ctx.font = "26px monospace";
      ctx.fillStyle = DIM;
      ctx.fillText(String(Math.round(m.volume)), 924, y);
    });
    tex.needsUpdate = true;
  }, [markets, offline, page, title, canvas, ctx, tex]);
  return tex;
}

/** The leaderboard board — who actually predicts well. */
function useLeaderTexture(leaders: Trader[], stats: HubStats | null) {
  const [canvas, ctx, tex] = useMemo(() => makeTex(1024, 640), []);
  useEffect(() => {
    ctx.fillStyle = "#05080b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#0d1319";
    ctx.fillRect(0, 0, canvas.width, 64);
    ctx.font = "bold 30px monospace";
    ctx.fillStyle = AMBER;
    ctx.fillText("TOP PREDICTORS — BY CAPITAL", 24, 42);
    leaders.slice(0, 6).forEach((t, i) => {
      const y = 130 + i * 56;
      ctx.font = "bold 26px monospace";
      ctx.fillStyle = i === 0 ? AMBER : "#cfd8de";
      ctx.fillText(`${i + 1}. ${(t.display_name ?? t.id).slice(0, 26)}`, 24, y);
      ctx.font = "26px monospace";
      ctx.fillStyle = GREEN;
      ctx.fillText(Number(t.capital).toFixed(1), 700, y);
      if (typeof t.reputation === "number") {
        ctx.fillStyle = DIM;
        ctx.fillText(`rep ${t.reputation.toFixed(2)}`, 830, y);
      }
    });
    if (stats) {
      ctx.font = "24px monospace";
      ctx.fillStyle = DIM;
      ctx.fillText(
        `${stats.markets_active ?? "—"} open · ${stats.trades_total ?? "—"} trades · ${stats.traders ?? "—"} traders`,
        24,
        600,
      );
    }
    tex.needsUpdate = true;
  }, [leaders, stats, canvas, ctx, tex]);
  return tex;
}

/** The scrolling LED ticker strip wrapping the room. */
function useTickerTexture(markets: Market[], offline: boolean) {
  const [canvas, ctx, tex] = useMemo(() => {
    const r = makeTex(4096, 64);
    r[2].wrapS = THREE.RepeatWrapping;
    return r;
  }, []);
  useEffect(() => {
    ctx.fillStyle = "#04070a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = "bold 34px monospace";
    let x = 20;
    const items = offline || markets.length === 0
      ? [{ q: "GHOST SIGNALS PREDICTION MARKET — FEED RECONNECTING", yes: null as number | null }]
      : markets.slice(0, 18).map((m) => ({ q: m.question.slice(0, 44), yes: (m.prices?.[0] ?? 0.5) * 100 }));
    for (const it of items) {
      ctx.fillStyle = "#cfd8de";
      ctx.fillText(it.q.toUpperCase(), x, 42);
      x += ctx.measureText(it.q.toUpperCase()).width + 18;
      if (it.yes != null) {
        const up = it.yes >= 50;
        ctx.fillStyle = up ? GREEN : RED;
        ctx.fillText(`${up ? "▲" : "▼"} YES ${it.yes.toFixed(1)}%`, x, 42);
        x += ctx.measureText(`▲ YES ${it.yes.toFixed(1)}%`).width + 20;
      }
      ctx.fillStyle = AMBER;
      ctx.fillText("●", x, 42);
      x += 44;
      if (x > canvas.width - 400) break;
    }
    tex.needsUpdate = true;
  }, [markets, offline, canvas, ctx, tex]);
  return tex;
}

/** The reception board: every storey, who holds it, lit by state. */
function useTowerBoardTexture(floors: TowerFloorRow[]) {
  const [canvas, ctx, tex] = useMemo(() => makeTex(768, 640), []);
  useEffect(() => {
    ctx.fillStyle = "#0a1017";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#141c25";
    ctx.fillRect(0, 0, canvas.width, 70);
    ctx.font = "bold 32px monospace";
    ctx.fillStyle = AMBER;
    ctx.fillText("GHOST SIGNALS TOWER — DIRECTORY", 24, 47);
    if (floors.length === 0) {
      ctx.font = "bold 30px monospace";
      ctx.fillStyle = DIM;
      ctx.fillText("directory loading…", 24, 150);
      tex.needsUpdate = true;
      return;
    }
    // Top floor first, the way a lobby board reads.
    [...floors].sort((a, b) => b.floorNo - a.floorNo).forEach((f, i) => {
      const y = 128 + i * 50;
      if (i % 2 === 0) {
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(12, y - 34, canvas.width - 24, 46);
      }
      ctx.font = "bold 28px monospace";
      ctx.fillStyle = "#cfd8de";
      ctx.fillText(String(f.floorNo).padStart(2, " "), 24, y);
      ctx.font = "28px monospace";
      if (f.status === "leased") {
        ctx.fillStyle = GREEN;
        ctx.fillText((f.label ?? "leased").slice(0, 30), 110, y);
      } else if (f.status === "dark") {
        ctx.fillStyle = RED;
        ctx.fillText(`${(f.label ?? "").slice(0, 22)} — DARK`.trim(), 110, y);
      } else {
        ctx.fillStyle = DIM;
        ctx.fillText("vacant — apply at tower/tenancies", 110, y);
      }
    });
    ctx.font = "22px monospace";
    ctx.fillStyle = DIM;
    ctx.fillText("G  TRADING FLOOR — YOU ARE HERE", 24, 128 + floors.length * 50 + 8);
    tex.needsUpdate = true;
  }, [floors, canvas, ctx, tex]);
  return tex;
}

/**
 * The reception desk — the piece of the operator's brief that makes the hall
 * a LOBBY: a counter, a concierge, and the building's directory behind them.
 */
function ReceptionDesk({ position, rotation, boardTex }: { position: [number, number, number]; rotation: number; boardTex: THREE.CanvasTexture }) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {/* Counter — dark stone with a brass reveal, at home beside the desks. */}
      <mesh position={[0, 0.62, 0]} castShadow>
        <boxGeometry args={[5.2, 1.24, 1.3]} />
        <meshStandardMaterial color="#141a1f" roughness={0.35} metalness={0.3} />
      </mesh>
      <mesh position={[0, 1.27, 0]}>
        <boxGeometry args={[5.35, 0.07, 1.42]} />
        <meshStandardMaterial color="#8d7a4f" roughness={0.35} metalness={0.7} />
      </mesh>
      {/* Concierge — BEHIND the counter (local −z), facing the visitors. */}
      <group position={[0.6, 0, -1.1]} rotation={[0, 0, 0]}>
        <NpcFigure color="#3d4a42" seed={99} />
      </group>
      {/* The directory board, standing behind the desk. */}
      <group position={[0, 2.9, -2.1]}>
        <mesh position={[0, 0, -0.03]}>
          <boxGeometry args={[4.4, 3.8, 0.18]} />
          <meshStandardMaterial color="#06090c" roughness={0.6} />
        </mesh>
        <mesh position={[0, 0, 0.08]}>
          <planeGeometry args={[4.1, 3.5]} />
          <meshBasicMaterial map={boardTex} toneMapped={false} />
        </mesh>
      </group>
      <Suspense fallback={null}>
        <Text position={[0, 1.75, 0.7]} fontSize={0.24} color="#e9dfc8" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.18}>
          RECEPTION
        </Text>
      </Suspense>
      <pointLight position={[0, 3.2, 0.8]} intensity={10} distance={8} color="#ffe2ae" />
    </group>
  );
}

/**
 * The elevator bank. Clicking it opens the floor-select overlay — the lift
 * itself is DOM, because ten storeys of 3D buttons is fiddliness nobody
 * asked for. Doors read as brushed metal with a lit indicator.
 */
function ElevatorBank({ position, onCall }: { position: [number, number, number]; onCall: () => void }) {
  const click = (e: { stopPropagation?: () => void; delta?: number }) => {
    if ((e.delta ?? 0) > 5) return;
    e.stopPropagation?.();
    onCall();
  };
  return (
    <group
      position={position}
      onClick={click}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "auto")}
    >
      {/* Surround */}
      <mesh position={[0, 2.9, -0.05]}>
        <boxGeometry args={[7.6, 5.8, 0.25]} />
        <meshStandardMaterial color="#171d22" roughness={0.5} metalness={0.4} />
      </mesh>
      {/* Two doors */}
      {[-1.9, 1.9].map((x) => (
        <group key={x} position={[x, 2.4, 0.12]}>
          <mesh>
            <boxGeometry args={[2.6, 4.6, 0.12]} />
            <meshStandardMaterial color="#4a545c" roughness={0.25} metalness={0.85} />
          </mesh>
          {/* Center seam */}
          <mesh position={[0, 0, 0.07]}>
            <boxGeometry args={[0.05, 4.6, 0.02]} />
            <meshStandardMaterial color="#20262b" roughness={0.4} metalness={0.6} />
          </mesh>
          {/* Indicator lamp */}
          <mesh position={[0, 2.55, 0.05]}>
            <boxGeometry args={[0.9, 0.28, 0.08]} />
            <meshStandardMaterial color="#101418" emissive="#4fe37f" emissiveIntensity={0.5} />
          </mesh>
        </group>
      ))}
      <Suspense fallback={null}>
        <Text position={[0, 5.35, 0.15]} fontSize={0.34} color="#e9dfc8" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.2}>
          ELEVATORS — FLOORS 2–11
        </Text>
        <Text position={[0, 0.35, 0.22]} fontSize={0.18} color="#7d8a96" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.12}>
          CLICK TO CALL
        </Text>
      </Suspense>
      <pointLight position={[0, 3.4, 1.4]} intensity={9} distance={8} color="#cfe4f2" />
    </group>
  );
}

/** Ticker band plane — scrolls its shared texture. */
function TickerBand({ tex, width, position, rotation }: { tex: THREE.CanvasTexture; width: number; position: [number, number, number]; rotation: [number, number, number] }) {
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const local = useMemo(() => {
    const t = tex.clone() as THREE.CanvasTexture;
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.set(width / 26, 1);
    return t;
  }, [tex, width]);
  useFrame((_, dt) => {
    local.offset.x += dt * 0.05;
  });
  // Keep pixels fresh when the source canvas redraws.
  useFrame(() => {
    if (tex.needsUpdate) local.needsUpdate = true;
  });
  return (
    <mesh position={position} rotation={rotation}>
      <planeGeometry args={[width, 0.85]} />
      <meshBasicMaterial ref={mat} map={local} toneMapped={false} />
    </mesh>
  );
}

/** A trading desk: dark counter, angled monitors with live-ish glow. */
function TradingDesk({ position, rotation, seed, market }: { position: [number, number, number]; rotation: number; seed: number; market: Market | null }) {
  const [canvas, ctx, tex] = useMemo(() => makeTex(256, 128), []);
  useEffect(() => {
    ctx.fillStyle = "#060a0d";
    ctx.fillRect(0, 0, 256, 128);
    // Mini random-walk chart, seeded so it doesn't shimmer
    let v = 64;
    let s = seed * 2654435761;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const up = (market?.prices?.[0] ?? 0.5) >= 0.5;
    ctx.strokeStyle = up ? GREEN : RED;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, v);
    for (let x = 4; x <= 256; x += 4) {
      v += (rnd() - (up ? 0.44 : 0.56)) * 14;
      v = Math.max(14, Math.min(114, v));
      ctx.lineTo(x, v);
    }
    ctx.stroke();
    ctx.font = "bold 15px monospace";
    ctx.fillStyle = "#cfd8de";
    ctx.fillText((market?.question ?? "GHOST SIGNALS").slice(0, 26), 8, 20);
    if (market) {
      const yes = (market.prices?.[0] ?? 0.5) * 100;
      ctx.fillStyle = yes >= 50 ? GREEN : RED;
      ctx.fillText(`YES ${yes.toFixed(1)}%`, 8, 118);
    }
    tex.needsUpdate = true;
  }, [market, seed, canvas, ctx, tex]);

  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 0.55, 0]} castShadow>
        <boxGeometry args={[3.4, 1.1, 1.2]} />
        <meshStandardMaterial color="#171b1f" roughness={0.55} metalness={0.2} />
      </mesh>
      <mesh position={[0, 1.12, 0]}>
        <boxGeometry args={[3.5, 0.06, 1.3]} />
        <meshStandardMaterial color="#22272c" roughness={0.4} metalness={0.4} />
      </mesh>
      {[-1.05, 0, 1.05].map((x, i) => (
        <group key={x} position={[x, 1.62, -0.25]} rotation={[-0.12, (i - 1) * 0.28, 0]}>
          <mesh>
            <boxGeometry args={[1.0, 0.62, 0.05]} />
            <meshStandardMaterial color="#0b0e11" roughness={0.4} />
          </mesh>
          <mesh position={[0, 0, 0.028]}>
            <planeGeometry args={[0.92, 0.54]} />
            <meshBasicMaterial map={tex} toneMapped={false} />
          </mesh>
          <mesh position={[0, -0.42, 0.1]}>
            <cylinderGeometry args={[0.035, 0.06, 0.24, 8]} />
            <meshStandardMaterial color="#22272c" metalness={0.5} roughness={0.4} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

export default function GsTradingFloor() {
  const [, navigate] = useLocation();
  const { markets, stats, leaders, offline } = useMarketFeed();
  const towerFloors = useTowerDirectory();
  const [liftOpen, setLiftOpen] = useState(false);

  const board1 = useBoardTexture(markets, offline, 0, "GHOST SIGNALS — OPEN MARKETS");
  const board2 = useBoardTexture(markets, offline, 1, "OPEN MARKETS — PAGE 2");
  const leaderTex = useLeaderTexture(leaders, stats);
  const ticker = useTickerTexture(markets, offline);
  const towerBoard = useTowerBoardTexture(towerFloors);

  // Hall: x ∈ [-22,22], z ∈ [-13,13], ceiling 12.
  const desks = useMemo(() => {
    const list: Array<{ pos: [number, number, number]; rot: number; seed: number }> = [];
    let i = 0;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 5; col++) {
        list.push({ pos: [-14 + col * 7, 0, -6.5 + row * 5.5], rot: row % 2 ? Math.PI : 0, seed: ++i * 13 });
      }
    }
    return list;
  }, []);

  const exitClick = (e: { stopPropagation?: () => void; delta?: number }) => {
    if ((e.delta ?? 0) > 5) return;
    e.stopPropagation?.();
    // Land on the tower plaza facing the street, not at the district gate.
    navigate("/city?from=__gs__");
  };

  return (
    <div className="relative h-screen w-full bg-[#05080b] overflow-hidden kax3d-font">
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-4 pointer-events-none">
        <Link href="/city" className="font-bold tracking-[0.3em] uppercase text-primary pointer-events-auto hover:text-primary/80" data-testid="link-back-city">
          ← City
        </Link>
        <a
          href="https://observatory.ninja-portal.com"
          target="_blank"
          rel="noreferrer"
          className="pointer-events-auto text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground border border-border px-3 py-2"
        >
          Observatory ↗
        </a>
      </div>

      {/* HUD */}
      <div className="absolute top-16 left-0 p-6 z-10 pointer-events-none">
        <div className="kax3d-hud p-5 rounded-none max-w-sm pointer-events-auto">
          <p className="text-[10px] text-accent font-bold uppercase tracking-[0.3em] mb-1">Ghost Signals Tower — ground floor</p>
          <h1 className="text-xl font-bold text-foreground tracking-widest uppercase" data-testid="text-floor-name">Prediction Market</h1>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">
            {offline
              ? "feed reconnecting…"
              : stats
                ? `${stats.markets_active ?? "—"} open markets · ${stats.trades_total ?? "—"} trades · ${stats.traders ?? "—"} traders`
                : "connecting to the hub…"}
          </p>
          <div className="mt-4 border-t border-border pt-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-widest leading-relaxed">
              Every screen is live LMSR market data. Reading is free — agents trade
              via the Command Center MCP (place_bet). The elevators by the entrance
              serve the leased floors above (KAX-ADR-0005).
            </p>
          </div>
        </div>
      </div>

      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-[0.4em] text-muted-foreground pointer-events-none z-10 font-bold">
        WASD to walk · Drag to look · EXIT door to leave · elevators to the floors
      </div>

      {/* The lift. DOM overlay, opened by clicking the elevator bank: the
          directory drawn from the same GET /api/tower the reception board
          reads, so the buttons and the board cannot disagree. */}
      {liftOpen && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70" onClick={() => setLiftOpen(false)} data-testid="overlay-elevator">
          <div className="kax3d-hud p-6 rounded-none w-[420px] max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <p className="text-[11px] text-accent font-bold uppercase tracking-[0.3em]">Ghost Signals Tower — elevator</p>
              <button onClick={() => setLiftOpen(false)} className="text-muted-foreground hover:text-foreground text-sm" data-testid="button-lift-close">✕</button>
            </div>
            {[...towerFloors].sort((a, b) => b.floorNo - a.floorNo).map((f) => (
              <button
                key={f.floorNo}
                onClick={() => { setLiftOpen(false); navigate(`/tower/${f.floorNo}`); }}
                data-testid={`button-lift-${f.floorNo}`}
                className="w-full flex items-center justify-between px-4 py-3 mb-1 border border-border hover:border-primary/60 hover:bg-primary/5 text-left"
              >
                <span className="text-sm font-bold text-foreground tracking-widest">{f.floorNo}</span>
                <span className={`text-[10px] uppercase tracking-widest ${f.status === "leased" ? "text-primary" : f.status === "dark" ? "text-destructive" : "text-muted-foreground"}`}>
                  {f.status === "leased" ? (f.label ?? "leased") : f.status === "dark" ? `${f.label ?? "leased"} · dark` : "vacant"}
                </span>
              </button>
            ))}
            {towerFloors.length === 0 && (
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest">directory loading…</p>
            )}
            <p className="text-[9px] text-muted-foreground/70 uppercase tracking-widest mt-3">
              Vacant floors are for lease — tower/tenancies in the Agent-Kax repo.
            </p>
          </div>
        </div>
      )}

      <Canvas
        className="!absolute inset-0"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        camera={{ position: [0, 2.2, 11], fov: 62 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
      >
        <color attach="background" args={["#05080b"]} />
        <fog attach="fog" args={["#05080b", 42, 95]} />

        {/* After-hours trading light: cool ambient + warm pools + screen glow */}
        <ambientLight intensity={0.55} color="#b9c8d4" />
        <hemisphereLight args={["#6d8090", "#1a2228", 0.7]} />
        <pointLight position={[0, 10, 0]} intensity={130} distance={44} color="#dfe8ee" />
        <pointLight position={[-14, 9, -6]} intensity={80} distance={30} color="#ffe2ae" />
        <pointLight position={[14, 9, 6]} intensity={80} distance={30} color="#ffe2ae" />

        <FirstPersonRig eyeHeight={2.2} speed={9} bounds={{ minX: -21, maxX: 21, minZ: -12, maxZ: 12.4, minY: 1.7, maxY: 9 }} />

        {/* Remote bodies on the trading floor. Without this the room is in
            the directory and renders nobody — an agent standing here would be
            somewhere no browser draws, which is the exact failure rooms.ts
            warns about: "a room you can stand in but nobody can see is not a
            room" (#300). */}
        <VenuePresence room="gs" />

        {/* Floor — dark polished stone */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
          <planeGeometry args={[44, 26]} />
          <meshStandardMaterial color="#1b2126" roughness={0.3} metalness={0.45} />
        </mesh>
        {/* Ceiling */}
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 12, 0]}>
          <planeGeometry args={[44, 26]} />
          <meshStandardMaterial color="#0b0f13" roughness={0.9} />
        </mesh>
        {/* Recessed ceiling light strips */}
        {[-14, -7, 0, 7, 14].map((x) => (
          <mesh key={x} position={[x, 11.9, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.5, 22]} />
            <meshStandardMaterial color="#e8f0f6" emissive="#dfe8ee" emissiveIntensity={1.1} toneMapped={false} />
          </mesh>
        ))}

        {/* Walls */}
        <mesh position={[0, 6, -13]}>
          <planeGeometry args={[44, 12]} />
          <meshStandardMaterial color="#232b33" roughness={0.8} />
        </mesh>
        <mesh position={[0, 6, 13]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[44, 12]} />
          <meshStandardMaterial color="#232b33" roughness={0.8} />
        </mesh>
        <mesh position={[-22, 6, 0]} rotation={[0, Math.PI / 2, 0]}>
          <planeGeometry args={[26, 12]} />
          <meshStandardMaterial color="#202830" roughness={0.8} />
        </mesh>
        <mesh position={[22, 6, 0]} rotation={[0, -Math.PI / 2, 0]}>
          <planeGeometry args={[26, 12]} />
          <meshStandardMaterial color="#202830" roughness={0.8} />
        </mesh>

        {/* Columns */}
        {[-16, 16].map((x) =>
          [-8, 8].map((z) => (
            <mesh key={`${x}${z}`} position={[x, 6, z]} castShadow>
              <boxGeometry args={[1.1, 12, 1.1]} />
              <meshStandardMaterial color="#1a2026" roughness={0.5} metalness={0.3} />
            </mesh>
          )),
        )}

        {/* THE BOARDS — live market walls */}
        <group position={[0, 6.2, -12.9]}>
          <mesh position={[0, 0, -0.03]}>
            <boxGeometry args={[19.6, 8.2, 0.2]} />
            <meshStandardMaterial color="#06090c" roughness={0.6} />
          </mesh>
          <mesh position={[0, 0, 0.12]}>
            <planeGeometry args={[19, 7.6]} />
            <meshBasicMaterial map={board1} toneMapped={false} />
          </mesh>
        </group>
        <group position={[-21.9, 6, 0]} rotation={[0, Math.PI / 2, 0]}>
          <mesh position={[0, 0, -0.03]}>
            <boxGeometry args={[15.6, 7.4, 0.2]} />
            <meshStandardMaterial color="#06090c" roughness={0.6} />
          </mesh>
          <mesh position={[0, 0, 0.12]}>
            <planeGeometry args={[15, 6.8]} />
            <meshBasicMaterial map={board2} toneMapped={false} />
          </mesh>
        </group>
        <group position={[21.9, 6, 0]} rotation={[0, -Math.PI / 2, 0]}>
          <mesh position={[0, 0, -0.03]}>
            <boxGeometry args={[15.6, 7.4, 0.2]} />
            <meshStandardMaterial color="#06090c" roughness={0.6} />
          </mesh>
          <mesh position={[0, 0, 0.12]}>
            <planeGeometry args={[15, 6.8]} />
            <meshBasicMaterial map={leaderTex} toneMapped={false} />
          </mesh>
        </group>

        {/* Scrolling ticker band wrapping the room */}
        <TickerBand tex={ticker} width={43} position={[0, 10.6, -12.85]} rotation={[0, 0, 0]} />
        <TickerBand tex={ticker} width={43} position={[0, 10.6, 12.85]} rotation={[0, Math.PI, 0]} />
        <TickerBand tex={ticker} width={25} position={[-21.85, 10.6, 0]} rotation={[0, Math.PI / 2, 0]} />
        <TickerBand tex={ticker} width={25} position={[21.85, 10.6, 0]} rotation={[0, -Math.PI / 2, 0]} />

        {/* Desks with screens + the floor's traders */}
        {desks.map((d, i) => (
          <TradingDesk key={i} position={d.pos} rotation={d.rot} seed={d.seed} market={markets[i] ?? null} />
        ))}
        {desks
          .filter((_, i) => i % 3 === 0)
          .map((d, i) => (
            <group key={`t${i}`} position={[d.pos[0] + 0.6, 0, d.pos[2] + (d.rot ? -1.3 : 1.3)]} rotation={[0, d.rot + Math.PI, 0]}>
              <NpcFigure color="#37424e" seed={i * 71 + 5} />
            </group>
          ))}

        {/* THE LOBBY — the operator's brief: reception, elevator, and room to
            breathe by the entry, with every trading feature untouched. The
            desks end at z=4.5; everything lobby-shaped lives z>6. */}
        {/* rotation 0: counter face, board, and concierge all address the
            south entrance; the hall sees the board's back, which is what a
            lobby fixture's back is for. Bank at z=12.7 so its deepest text
            (local 0.22) stays proud of the wall at z=13 — at 12.8 the CLICK
            TO CALL hint rendered INSIDE the wall (review finding 1). */}
        <ReceptionDesk position={[8.5, 0, 9.2]} rotation={0} boardTex={towerBoard} />
        <ElevatorBank position={[-14.5, 0, 12.7]} onCall={() => setLiftOpen(true)} />

        {/* GS crest on the back wall over the entry */}
        <Suspense fallback={null}>
          <Text position={[0, 8.6, 12.9]} rotation={[0, Math.PI, 0]} fontSize={1.0} color="#e9dfc8" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.14}>
            GHOST SIGNALS
          </Text>
          <Text position={[0, 7.6, 12.9]} rotation={[0, Math.PI, 0]} fontSize={0.36} color="#b9ac90" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.3}>
            A BELIEF YOU WILL NOT PRICE IS JUST A MOOD
          </Text>
        </Suspense>

        {/* EXIT — glass doors back to the street */}
        <group
          onClick={exitClick}
          onPointerOver={() => (document.body.style.cursor = "pointer")}
          onPointerOut={() => (document.body.style.cursor = "auto")}
        >
          <mesh position={[0, 2.6, 12.92]} rotation={[0, Math.PI, 0]}>
            <planeGeometry args={[6, 5.2]} />
            <meshStandardMaterial color="#dfe8ee" emissive="#cfdde8" emissiveIntensity={0.5} />
          </mesh>
          {[-1.5, 1.5].map((x) => (
            <mesh key={x} position={[x, 2.4, 12.8]} rotation={[0, Math.PI, 0]}>
              <planeGeometry args={[2.7, 4.8]} />
              <meshPhysicalMaterial color="#9fb4bd" transparent opacity={0.3} roughness={0.08} side={THREE.DoubleSide} />
            </mesh>
          ))}
          <mesh position={[0, 5.35, 12.75]}>
            <boxGeometry args={[1.6, 0.6, 0.16]} />
            <meshStandardMaterial color="#132015" emissive="#0d3818" emissiveIntensity={0.8} />
          </mesh>
          <Suspense fallback={null}>
            <Text position={[0, 5.35, 12.62]} rotation={[0, Math.PI, 0]} fontSize={0.36} color="#6dff8f" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.18}>
              EXIT
            </Text>
          </Suspense>
        </group>
      </Canvas>
    </div>
  );
}
