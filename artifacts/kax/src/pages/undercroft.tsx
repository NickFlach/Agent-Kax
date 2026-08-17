import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import { Link, useLocation } from "wouter";
import { useGetMarketplaceCombined } from "@workspace/api-client-react";
import { FirstPersonRig, type FpsSpawn } from "@/components/first-person-rig";
import { VenuePresence } from "@/components/presence";
import { DirectoryBoard, useCityRooms } from "@/components/directory-board";
import { concreteTexture, sidewalkTexture, stuccoTexture, repeated } from "@/lib/city-textures";
import { DISPLAY_FONT } from "@/lib/fonts";
import { storefrontWindowCard } from "@/lib/storefront-window";
import { MAX_STREET_STOREFRONTS } from "@/lib/city-layout";
import {
  HALL_HALF_X,
  HALL_NORTH_Z,
  HALL_SOUTH_Z,
  MAX_UNDERCROFT_UNITS,
  NORTH_LOBBY,
  SOUTH_LOBBY,
  UNDERCROFT_BOUNDS,
  UNDERCROFT_CEILING_Y,
  UNDERCROFT_ENTRANCES,
  UNDERCROFT_EYE,
  UNDERCROFT_FLOOR_Y,
  UNDERCROFT_HALF_X,
  UNDERCROFT_SURFACE_Y,
  rankUndercroft,
  undercroftGroundHeight,
  undercroftObstacles,
  undercroftSlots,
  type UndercroftCandidate,
  type UndercroftEntrance,
} from "@/lib/undercroft";
import "./marketplace-3d.css";

/**
 * THE UNDERCROFT — the second forty-eight, one storey down.
 *
 * Nick's brief, and the reason this is not decoration: "I've wondered what we
 * would do with some of the stores that would never be occupied… we are going
 * to want commerce enabled stores ranked towards the top. But I think we should
 * keep the original 48 exactly how they are for now and add a second 48
 * directly underneath the main road." The motive he gave is PRESERVATION —
 * dormant-but-interesting agents should have somewhere to exist rather than
 * being culled from the street.
 *
 * ITS OWN SCENE, ON PURPOSE. The street's obstacle array is untouched, its
 * layout function is untouched, and its 48-cut is untouched. `city-layout.test.ts`
 * pins all forty-eight street positions against a frozen table so that is a
 * checked fact rather than an intention.
 *
 * The grid down here is the street's own `layoutFor`, called with a different
 * Y — same 4.5 pitch, same alternating sides, same row jitter. The two tiers
 * read as related because they are the same code, not because somebody copied
 * the numbers across.
 *
 * WHAT IS NOT HERE. No `<Horizon>`: the sea plane sits at y = -1.2 on the
 * street and everything down here is below it. Underground has no sky.
 */

/* ------------------------------------------------------------- scene pieces */

const UNIT_W = 3.0;
const UNIT_H = 2.9;

/** One unit in the concourse wall: glass, a sign, and what is in the window. */
function Unit({
  unit,
  position,
  rotation,
  onEnter,
}: {
  unit: UndercroftCandidate;
  position: [number, number, number];
  rotation: [number, number, number];
  onEnter: (u: UndercroftCandidate) => void;
}) {
  // The street's predicate, not a second copy of it. #302: `claimed` means
  // "has a non-system owner", NOT "empty" — and 278 of 302 unclaimed
  // storefronts hold work, median 24 artifacts. A store with a body of work
  // behind the glass must not have FOR LEASE in the window.
  const card = storefrontWindowCard(unit);
  const lit = card !== "for-lease";
  const initials = (unit.name || unit.slug).substring(0, 2).toUpperCase();

  return (
    <group position={position} rotation={rotation}>
      {/* Shopfront box, let into the concourse wall. */}
      <mesh position={[0, UNIT_H / 2, -0.5]} castShadow receiveShadow>
        <boxGeometry args={[UNIT_W, UNIT_H, 2.2]} />
        <meshStandardMaterial color={lit ? "#3b4048" : "#2b2f34"} roughness={0.94} />
      </mesh>
      {/* Display glass. Lit units glow; a vacant one is dark. */}
      <mesh
        position={[0, 1.35, 0.62]}
        onClick={(e) => {
          if ((e.delta ?? 0) > 5) return;
          e.stopPropagation();
          onEnter(unit);
        }}
      >
        <planeGeometry args={[UNIT_W - 0.5, 1.9]} />
        <meshStandardMaterial
          color={lit ? "#9fd4e6" : "#1b2126"}
          emissive={lit ? "#2d6a80" : "#000000"}
          emissiveIntensity={lit ? 0.85 : 0}
          roughness={0.25}
        />
      </mesh>
      {lit && <pointLight position={[0, 1.6, 1.1]} intensity={5} distance={5.5} decay={2} color="#bfe6f2" />}

      {/* Fascia sign. */}
      <mesh position={[0, 2.45, 0.63]}>
        <planeGeometry args={[UNIT_W - 0.2, 0.5]} />
        <meshStandardMaterial color="#20262b" roughness={0.9} />
      </mesh>
      <Suspense fallback={null}>
        <Text
          position={[0, 2.45, 0.66]}
          fontSize={0.17}
          color={lit ? "#dbe8ef" : "#6d757c"}
          font={DISPLAY_FONT}
          anchorX="center"
          anchorY="middle"
          maxWidth={UNIT_W - 0.3}
        >
          {(unit.name || unit.slug).slice(0, 22)}
        </Text>
      </Suspense>
      <Suspense fallback={null}>
        <Text position={[0, 0.42, 0.64]} fontSize={0.11} color="#8fa3ad" font={DISPLAY_FONT} anchorX="center" anchorY="middle">
          {initials}
        </Text>
      </Suspense>

      {/* The window card. Three states, and only one of them says vacant. */}
      <Suspense fallback={null}>
        {card === "for-lease" ? (
          <Text position={[0, 1.35, 0.66]} fontSize={0.15} color="#b9a06a" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.14}>
            FOR LEASE
          </Text>
        ) : card === "unclaimed-with-works" ? (
          <>
            <Text position={[0, 1.55, 0.66]} fontSize={0.13} color="#123540" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.1}>
              {`${unit.artifacts} WORKS INSIDE`}
            </Text>
            <Text position={[0, 1.3, 0.66]} fontSize={0.085} color="#1b4351" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.14}>
              UNCLAIMED · CAN BE CLAIMED
            </Text>
          </>
        ) : null}
      </Suspense>
    </group>
  );
}

/** The cutting one ramp runs down, and the arrival apron at the top of it. */
function Entrance({ e }: { e: UndercroftEntrance }) {
  const { court, shaft } = e;
  const courtW = court.x1 - court.x0;
  const courtD = court.z1 - court.z0;
  const shaftW = shaft.x1 - shaft.x0;
  const shaftD = shaft.z1 - shaft.z0;
  const pavers = useMemo(() => repeated(sidewalkTexture(), 4, 4), []);
  const rock = useMemo(() => repeated(stuccoTexture(3), 3, 2), []);

  // The ramp deck, as one long slab tilted by its own rise over run.
  const rampTilt = Math.atan2(-(UNDERCROFT_SURFACE_Y - UNDERCROFT_FLOOR_Y), e.deckBottomZ - e.deckTopZ);
  const rampMidZ = (e.deckTopZ + e.deckBottomZ) / 2;
  const rampLen = Math.hypot(e.deckBottomZ - e.deckTopZ, UNDERCROFT_SURFACE_Y - UNDERCROFT_FLOOR_Y);
  const rampX = (shaft.x0 + shaft.x1) / 2;

  return (
    <group>
      {/* The apron you arrive on. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[(court.x0 + court.x1) / 2, UNDERCROFT_SURFACE_Y, (court.z0 + court.z1) / 2]} receiveShadow>
        <planeGeometry args={[courtW, courtD]} />
        <meshStandardMaterial map={pavers} roughness={0.95} />
      </mesh>
      {/* The ramp itself. */}
      <mesh rotation={[-Math.PI / 2 + rampTilt, 0, 0]} position={[rampX, (UNDERCROFT_SURFACE_Y + UNDERCROFT_FLOOR_Y) / 2, rampMidZ]} receiveShadow>
        <planeGeometry args={[shaftW, rampLen]} />
        <meshStandardMaterial map={pavers} roughness={0.97} />
      </mesh>
      {/* The rock the cutting is cut through. */}
      {[shaft.x0 - 0.3, shaft.x1 + 0.3].map((x) => (
        <mesh key={x} position={[x, UNDERCROFT_FLOOR_Y / 2, (shaft.z0 + shaft.z1) / 2]} receiveShadow>
          <boxGeometry args={[0.6, Math.abs(UNDERCROFT_FLOOR_Y) + 1.2, Math.abs(shaftD)]} />
          <meshStandardMaterial map={rock} roughness={1} color="#5c625f" />
        </mesh>
      ))}

      {/* Railings — the reason nobody walks off the apron. */}
      {[
        [court.x0 - 0.1, (court.z0 + court.z1) / 2, 0.12, courtD],
        [court.x1 + 0.1, (court.z0 + court.z1) / 2, 0.12, courtD],
      ].map(([x, z, w, d], i) => (
        <mesh key={`r${i}`} position={[x!, UNDERCROFT_SURFACE_Y + 0.55, z!]}>
          <boxGeometry args={[w!, 1.1, d!]} />
          <meshStandardMaterial color="#4a5157" metalness={0.5} roughness={0.5} />
        </mesh>
      ))}

      {/* ENTRY SIGNAGE. A visitor has to be able to tell, standing here, what
          this is and that there is a whole street of it below. */}
      <Suspense fallback={null}>
        <Text
          position={[(court.x0 + court.x1) / 2, UNDERCROFT_SURFACE_Y + 2.4, (court.z0 + court.z1) / 2 - e.fallDir * (courtD / 2 - 0.4)]}
          rotation={[0, e.fallDir > 0 ? Math.PI : 0, 0]}
          fontSize={0.52}
          color="#cfe4f2"
          font={DISPLAY_FONT}
          anchorX="center"
          anchorY="middle"
          letterSpacing={0.16}
        >
          THE UNDERCROFT
        </Text>
      </Suspense>
      <Suspense fallback={null}>
        <Text
          position={[(court.x0 + court.x1) / 2, UNDERCROFT_SURFACE_Y + 1.85, (court.z0 + court.z1) / 2 - e.fallDir * (courtD / 2 - 0.4)]}
          rotation={[0, e.fallDir > 0 ? Math.PI : 0, 0]}
          fontSize={0.16}
          color="#8fb2c4"
          font={DISPLAY_FONT}
          anchorX="center"
          anchorY="middle"
          letterSpacing={0.22}
        >
          {`${MAX_UNDERCROFT_UNITS} UNITS BELOW · WALK DOWN`}
        </Text>
      </Suspense>
      <pointLight position={[rampX, UNDERCROFT_SURFACE_Y + 2.6, e.deckTopZ]} intensity={24} distance={16} decay={2} color="#ffd9a0" />
      <pointLight position={[rampX, UNDERCROFT_FLOOR_Y + 2.6, e.deckBottomZ]} intensity={22} distance={15} decay={2} color="#cfe6f2" />
    </group>
  );
}

/** Reports where the player is, so a headless walk can prove the descent. */
function CamProbe() {
  const { camera } = useThree();
  const last = useRef(0);
  useFrame((s) => {
    if (s.clock.elapsedTime - last.current < 0.15) return;
    last.current = s.clock.elapsedTime;
    // Same hook `residences.tsx` sets. The street's PlayerTracker reports
    // {x,z,h} into React state and never reports y, so a descent could not be
    // measured headless at all before this.
    (window as unknown as { __kaxCam?: unknown }).__kaxCam = {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
    };
  });
  return null;
}

/* ------------------------------------------------------------------ the page */

export default function Undercroft() {
  const [, navigate] = useLocation();
  const { data, isLoading } = useGetMarketplaceCombined();
  const cityRooms = useCityRooms();

  /**
   * The remainder, ranked.
   *
   * `slice(MAX_STREET_STOREFRONTS)` takes everything the street did NOT
   * show, in the order the API returned it, and then re-sorts a copy. The
   * street's own array is never touched — `rankUndercroft` sorts a copy for
   * exactly that reason, because `Array.prototype.sort` mutates and both tiers
   * read the same response.
   */
  const units = useMemo(() => {
    if (!data) return [];
    const all: UndercroftCandidate[] = data.storefronts.map((s) => ({
      slug: s.slug,
      name: s.settings.displayName || s.agent.displayName,
      drops: s.publishedDropCount,
      artifacts: s.artifactCount,
      latestPublishedAt: s.latestPublishedAt ?? null,
      claimed: s.claimed,
      source: s.source,
    }));
    return rankUndercroft(all.slice(MAX_STREET_STOREFRONTS));
  }, [data]);

  const slots = useMemo(() => undercroftSlots(), []);
  const obstacles = useMemo(() => undercroftObstacles(), []);
  const floorTex = useMemo(() => repeated(concreteTexture(), 6, 90), []);

  // Which ramp you came down. The street sends ?from=undercroft-north|south.
  const [spawn, setSpawn] = useState<FpsSpawn | null>(null);
  useEffect(() => {
    if (spawn) return;
    const from = new URLSearchParams(window.location.search).get("from");
    const e = UNDERCROFT_ENTRANCES.find((x) => x.id === from) ?? UNDERCROFT_ENTRANCES[0]!;
    setSpawn({ position: e.spawn, yaw: e.yaw });
  }, [spawn]);

  const hallLen = Math.abs(HALL_NORTH_Z - HALL_SOUTH_Z);
  const hallMidZ = (HALL_NORTH_Z + HALL_SOUTH_Z) / 2;
  const totalLen = NORTH_LOBBY.z1 - SOUTH_LOBBY.z0;
  const totalMidZ = (NORTH_LOBBY.z1 + SOUTH_LOBBY.z0) / 2;

  return (
    <div className="relative h-screen w-full bg-[#0b1116] overflow-hidden kax3d-font">
      <div className="absolute top-0 left-0 right-0 p-4 z-20 flex items-center gap-4 pointer-events-none">
        <Link
          href="/city?from=__undercroft__"
          className="font-bold tracking-[0.3em] uppercase text-primary pointer-events-auto hover:text-primary/80"
          data-testid="link-back-city"
        >
          ← Street
        </Link>
      </div>

      <div className="absolute top-16 left-0 p-6 z-10 pointer-events-none">
        <div className="kax3d-hud p-5 rounded-none max-w-sm pointer-events-auto">
          <p className="text-[10px] text-accent font-bold uppercase tracking-[0.3em] mb-1">Below the road</p>
          <h1 className="text-xl font-bold text-foreground tracking-widest uppercase" data-testid="text-undercroft-name">
            The Undercroft
          </h1>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-1">
            the next {MAX_UNDERCROFT_UNITS}, ranked · drops, then work, then who is still breathing
          </p>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-2" data-testid="text-undercroft-count">
            {isLoading ? "cutting the rock…" : `${units.length} units occupied`}
          </p>
        </div>
      </div>

      <Canvas
        className="!absolute inset-0"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        camera={{ position: [UNDERCROFT_ENTRANCES[0]!.spawn[0], UNDERCROFT_ENTRANCES[0]!.spawn[1], UNDERCROFT_ENTRANCES[0]!.spawn[2]], fov: 68 }}
        dpr={[1, 1.5]}
        shadows
      >
        <fog attach="fog" args={["#0b1116", 18, 78]} />
        <ambientLight intensity={0.34} color="#b9cbd8" />
        <hemisphereLight args={["#9fb6c6", "#20262b", 0.5]} />
        {/* Daylight down the two cuttings — the only outside light there is. */}
        {UNDERCROFT_ENTRANCES.map((e) => (
          <directionalLight
            key={e.id}
            position={[(e.shaft.x0 + e.shaft.x1) / 2, 9, e.deckTopZ]}
            intensity={0.55}
            color="#d8e6f0"
          />
        ))}

        {/* Concourse floor, ceiling, and the rock beyond the walls. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, UNDERCROFT_FLOOR_Y, totalMidZ]} receiveShadow>
          <planeGeometry args={[UNDERCROFT_HALF_X * 2, totalLen]} />
          <meshStandardMaterial map={floorTex} roughness={0.95} />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, UNDERCROFT_CEILING_Y, hallMidZ]}>
          <planeGeometry args={[HALL_HALF_X * 2, hallLen]} />
          <meshStandardMaterial color="#191f24" roughness={1} />
        </mesh>
        {[-1, 1].map((side) => (
          <mesh key={side} position={[HALL_HALF_X * side, (UNDERCROFT_FLOOR_Y + UNDERCROFT_CEILING_Y) / 2, hallMidZ]} receiveShadow>
            <boxGeometry args={[0.6, Math.abs(UNDERCROFT_CEILING_Y - UNDERCROFT_FLOOR_Y), hallLen]} />
            <meshStandardMaterial color="#343a3e" roughness={1} />
          </mesh>
        ))}

        {/* The two lobbies. Without these the foot of each ramp faces open
            black — the headless walk landed there and photographed a void.
            Purely scenery: the rig is already held inside UNDERCROFT_BOUNDS,
            so none of this needs a collision box. */}
        {[NORTH_LOBBY, SOUTH_LOBBY].map((lobby, i) => {
          const zMid = (lobby.z0 + lobby.z1) / 2;
          const len = Math.abs(lobby.z1 - lobby.z0);
          const endZ = i === 0 ? Math.max(lobby.z0, lobby.z1) : Math.min(lobby.z0, lobby.z1);
          return (
            <group key={`lobby-${i}`}>
              <mesh position={[0, UNDERCROFT_FLOOR_Y + 2.2, endZ]} rotation={[0, i === 0 ? Math.PI : 0, 0]} receiveShadow>
                <planeGeometry args={[UNDERCROFT_HALF_X * 2, 4.4]} />
                <meshStandardMaterial color="#2b3238" roughness={1} />
              </mesh>
              {[-1, 1].map((side) => (
                <mesh
                  key={side}
                  position={[UNDERCROFT_HALF_X * side, UNDERCROFT_FLOOR_Y + 2.2, zMid]}
                  rotation={[0, side < 0 ? Math.PI / 2 : -Math.PI / 2, 0]}
                  receiveShadow
                >
                  <planeGeometry args={[len, 4.4]} />
                  <meshStandardMaterial color="#31383d" roughness={1} />
                </mesh>
              ))}
              <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, UNDERCROFT_FLOOR_Y + 4.4, zMid]}>
                <planeGeometry args={[UNDERCROFT_HALF_X * 2, len]} />
                <meshStandardMaterial color="#1a2025" roughness={1} />
              </mesh>
              <pointLight position={[0, UNDERCROFT_FLOOR_Y + 3.6, zMid]} intensity={26} distance={22} decay={2} color="#dfeaf2" />
              <Suspense fallback={null}>
                <Text
                  position={[0, UNDERCROFT_FLOOR_Y + 2.9, endZ + (i === 0 ? -0.06 : 0.06)]}
                  rotation={[0, i === 0 ? Math.PI : 0, 0]}
                  fontSize={0.46}
                  color="#9fc4d6"
                  font={DISPLAY_FONT}
                  anchorX="center"
                  anchorY="middle"
                  letterSpacing={0.2}
                >
                  THE UNDERCROFT
                </Text>
              </Suspense>
              <Suspense fallback={null}>
                <Text
                  position={[0, UNDERCROFT_FLOOR_Y + 2.35, endZ + (i === 0 ? -0.06 : 0.06)]}
                  rotation={[0, i === 0 ? Math.PI : 0, 0]}
                  fontSize={0.15}
                  color="#6d8794"
                  font={DISPLAY_FONT}
                  anchorX="center"
                  anchorY="middle"
                  letterSpacing={0.24}
                >
                  {i === 0 ? "UNITS 1–48 · THIS WAY" : "UNITS 1–48 · BACK THIS WAY"}
                </Text>
              </Suspense>
            </group>
          );
        })}

        {/* Strip lighting down the corridor so it reads as a concourse. */}
        {Array.from({ length: 26 }).map((_, i) => (
          <pointLight
            key={i}
            position={[0, UNDERCROFT_CEILING_Y - 0.25, 18 - i * 5]}
            intensity={7}
            distance={11}
            decay={2}
            color="#cfe0ea"
          />
        ))}

        {UNDERCROFT_ENTRANCES.map((e) => (
          <Entrance key={e.id} e={e} />
        ))}

        {/* Reused from #305: the same standing board the street uses, so a
            visitor down here can still see what the city has and get back. */}
        {UNDERCROFT_ENTRANCES.map((e) => (
          <DirectoryBoard
            key={`board-${e.id}`}
            position={[(e.court.x0 + e.court.x1) / 2 + (e.side < 0 ? 2.6 : -2.6), UNDERCROFT_SURFACE_Y, (e.court.z0 + e.court.z1) / 2]}
            rotation={e.side < 0 ? -Math.PI / 2 : Math.PI / 2}
            rooms={cityRooms}
            heading="KAX CITY"
          />
        ))}

        {units.map((unit, i) => {
          const slot = slots[i];
          if (!slot) return null;
          return (
            <Unit
              key={unit.slug}
              unit={unit}
              position={slot.position}
              rotation={slot.rotation}
              onEnter={(u) => navigate(u.source === "constellation" ? `/constellation/${u.slug}` : `/s/${u.slug}/room`)}
            />
          );
        })}

        <FirstPersonRig
          eyeHeight={UNDERCROFT_EYE}
          speed={9}
          bounds={UNDERCROFT_BOUNDS}
          obstacles={obstacles}
          spawn={spawn}
          groundHeight={undercroftGroundHeight}
        />
        <CamProbe />
        {/* Without this the Undercroft is a room the directory lists and
            nobody is drawn in — the failure rooms.ts warns about and #300
            fixed for the trading floor. */}
        <VenuePresence room="undercroft" />
      </Canvas>
    </div>
  );
}
