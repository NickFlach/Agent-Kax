import { Suspense, useMemo } from "react";
import { Text } from "@react-three/drei";
import {
  asphaltTexture,
  sidewalkTexture,
  brickTexture,
  concreteTexture,
  awningTexture,
  repeated,
} from "@/lib/city-textures";
import type { DayPhase } from "@/lib/time-of-day";
import { DISPLAY_FONT } from "@/lib/fonts";


/**
 * The parts of a city that aren't the shopfront.
 *
 * A district that is only its main street reads as a stage set. These are the
 * pieces behind and between: service alleys running behind both shop rows,
 * cross streets connecting them to the main strip, and the corner the cafe
 * sits on. The alley is where the city keeps what it doesn't display —
 * dumpsters, fire escapes, stacked crates, a bulb over a steel door.
 *
 * Geometry sits between the storefront row (facades at ±6, obstacles out to
 * ~±7.6) and the skyline blocks (centred ±16, half-width 3.75, so their near
 * face is ≈±12.25). The alleys run down the gap at ±10.
 */

export const ALLEY_X = 11;

/** Service alley behind one shop row. `side` is -1 for west, +1 for east. */
export function BackAlley({ side, depth, lit }: { side: 1 | -1; depth: number; lit: boolean }) {
  const length = Math.abs(depth) + 16;
  const zMid = (4 + depth - 8) / 2;
  const ground = useMemo(() => repeated(asphaltTexture(), 2, length / 5), [length]);
  const wall = useMemo(() => repeated(brickTexture(1), 1, length / 6), [length]);
  const backWall = useMemo(() => repeated(brickTexture(3), 1, length / 6), [length]);

  // Props march down the alley at irregular intervals so it never reads tiled.
  const props = useMemo(() => {
    const out: Array<{ z: number; kind: "dumpster" | "crates" | "pipes" | "escape" | "lamp" }> = [];
    const kinds = ["dumpster", "escape", "crates", "lamp", "pipes", "dumpster", "escape", "crates"] as const;
    let i = 0;
    for (let z = 2; z > depth - 4; z -= 8 + (i % 3) * 1.5) {
      out.push({ z, kind: kinds[i % kinds.length]! });
      i++;
    }
    return out;
  }, [depth]);

  return (
    <group>
      {/* Alley floor — wet asphalt, a little lower than the sidewalks */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[ALLEY_X * side, 0.1, zMid]} receiveShadow>
        <planeGeometry args={[6.2, length]} />
        <meshStandardMaterial map={ground} roughness={0.72} metalness={0.06} />
      </mesh>

      {/* Backs of the shops (inner wall) and the block behind (outer wall) */}
      <mesh position={[(ALLEY_X - 3.1) * side, 3.4, zMid]} rotation={[0, -side * Math.PI / 2, 0]} receiveShadow>
        <planeGeometry args={[length, 6.8]} />
        <meshStandardMaterial map={wall} roughness={0.95} />
      </mesh>
      <mesh position={[(ALLEY_X + 3.1) * side, 4.6, zMid]} rotation={[0, side * Math.PI / 2, 0]} receiveShadow>
        <planeGeometry args={[length, 9.2]} />
        <meshStandardMaterial map={backWall} roughness={0.95} />
      </mesh>

      {/* Puddles. They only read at night, when the service bulbs give them
          something to hold — which is the point: the alley is worth walking
          into after dark, and merely a service road before it. */}
      {props.map((p, i) => (
        <mesh
          key={`pud${i}`}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[ALLEY_X * side + (i % 2 ? 0.9 : -0.7) * side, 0.105, p.z - 2.4]}
        >
          <circleGeometry args={[0.55 + (i % 3) * 0.35, 18]} />
          <meshStandardMaterial
            color={lit ? "#1d2733" : "#22262c"}
            roughness={0.08}
            metalness={0.85}
            emissive={lit ? "#2a2010" : "#000000"}
            emissiveIntensity={lit ? 0.35 : 0}
          />
        </mesh>
      ))}

      {props.map((p, i) => (
        <group key={i} position={[ALLEY_X * side, 0.1, p.z]}>
          {p.kind === "dumpster" && (
            <group position={[-1.9 * side, 0, 0]} rotation={[0, side * 0.12, 0]}>
              <mesh position={[0, 0.62, 0]} castShadow receiveShadow>
                <boxGeometry args={[1.5, 1.24, 1.0]} />
                <meshStandardMaterial color={i % 2 ? "#2f4a3a" : "#3a3f4a"} roughness={0.85} metalness={0.25} />
              </mesh>
              <mesh position={[0, 1.27, 0]} rotation={[i % 2 ? -0.5 : 0, 0, 0]} castShadow>
                <boxGeometry args={[1.55, 0.08, 1.05]} />
                <meshStandardMaterial color={i % 2 ? "#28402f" : "#32363f"} roughness={0.8} metalness={0.3} />
              </mesh>
            </group>
          )}
          {p.kind === "crates" && (
            <group position={[-2.2 * side, 0, 0]}>
              {[0, 1, 2].map((k) => (
                <mesh key={k} position={[(k % 2) * 0.1, 0.28 + k * 0.52, (k % 2) * 0.2]} rotation={[0, k * 0.3, 0]} castShadow>
                  <boxGeometry args={[0.86, 0.5, 0.7]} />
                  <meshStandardMaterial color={k === 1 ? "#6a4b2f" : "#5c4530"} roughness={0.92} />
                </mesh>
              ))}
            </group>
          )}
          {p.kind === "pipes" && (
            <group position={[-2.85 * side, 0, 0]}>
              {[0.5, 0.95].map((off) => (
                <mesh key={off} position={[0, 3.2, 0]} rotation={[0, 0, 0]}>
                  <cylinderGeometry args={[0.09, 0.09, 6.4, 8]} />
                  <meshStandardMaterial color="#3f4650" metalness={0.5} roughness={0.6} />
                </mesh>
              ))}
              <mesh position={[0.18 * side, 0.16, 0]}>
                <boxGeometry args={[0.5, 0.32, 0.5]} />
                <meshStandardMaterial color="#39404a" metalness={0.4} roughness={0.7} />
              </mesh>
            </group>
          )}
          {p.kind === "escape" && (
            <group position={[-2.85 * side, 0, 0]}>
              {[2.6, 4.6].map((y) => (
                <group key={y} position={[0, y, 0]}>
                  <mesh position={[0.55 * side, 0, 0]} castShadow>
                    <boxGeometry args={[1.1, 0.08, 2.2]} />
                    <meshStandardMaterial color="#2b3038" metalness={0.55} roughness={0.6} />
                  </mesh>
                  <mesh position={[1.08 * side, 0.5, 0]}>
                    <boxGeometry args={[0.05, 1.0, 2.2]} />
                    <meshStandardMaterial color="#2b3038" metalness={0.55} roughness={0.6} />
                  </mesh>
                </group>
              ))}
              <mesh position={[0.9 * side, 3.6, 1.0]} rotation={[0.9, 0, 0]}>
                <boxGeometry args={[0.9, 0.06, 2.6]} />
                <meshStandardMaterial color="#2b3038" metalness={0.55} roughness={0.6} />
              </mesh>
            </group>
          )}
          {/* A steel service door in the shop's back wall, with its bulb */}
          {(p.kind === "lamp" || p.kind === "escape") && (
            <group position={[-2.95 * side, 0, 1.4]}>
              <mesh position={[0, 1.15, 0]} rotation={[0, -side * Math.PI / 2, 0]}>
                <planeGeometry args={[1.05, 2.3]} />
                <meshStandardMaterial color="#3c4048" metalness={0.4} roughness={0.7} />
              </mesh>
              <mesh position={[0.07 * side, 2.62, 0]}>
                <boxGeometry args={[0.26, 0.12, 0.34]} />
                <meshStandardMaterial color="#22262c" />
              </mesh>
              <mesh position={[0.07 * side, 2.5, 0]}>
                <sphereGeometry args={[0.075, 8, 8]} />
                <meshStandardMaterial
                  color="#fff0c8"
                  emissive="#ffcf84"
                  emissiveIntensity={lit ? 3 : 0.1}
                />
              </mesh>
              {lit && <pointLight position={[0.2 * side, 2.4, 0]} intensity={9} distance={7} decay={2} color="#ffcf84" />}
            </group>
          )}
        </group>
      ))}
      {/* Somebody kept a tally back here. Nobody announces it; you either
          wander down and find it or you never know it exists. */}
      <group position={[(ALLEY_X - 3.0) * side, 0, depth * 0.45]} rotation={[0, -side * Math.PI / 2, 0]}>
        {[0, 1, 2, 3].map((k) => (
          <mesh key={k} position={[-0.36 + k * 0.16, 1.35, 0.02]} rotation={[0, 0, 0.06 - k * 0.04]}>
            <boxGeometry args={[0.035, 0.34, 0.01]} />
            <meshStandardMaterial color="#cdc6b4" roughness={1} />
          </mesh>
        ))}
        <mesh position={[0.12, 1.35, 0.02]} rotation={[0, 0, 1.25]}>
          <boxGeometry args={[0.035, 0.52, 0.01]} />
          <meshStandardMaterial color="#cdc6b4" roughness={1} />
        </mesh>
        <Suspense fallback={null}>
          <Text position={[0, 0.95, 0.03]} fontSize={0.1} color="#8d8471" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.1}>
            FIVE SO FAR
          </Text>
        </Suspense>
      </group>
    </group>
  );
}

/** A cross street joining the main strip to both alleys. */
export function SideStreet({ z, lit }: { z: number; lit: boolean }) {
  const road = useMemo(() => repeated(asphaltTexture(), 6, 1), []);
  const walk = useMemo(() => repeated(sidewalkTexture(), 6, 1), []);
  return (
    <group position={[0, 0, z]}>
      {/* Roadway running east-west, meeting the alleys at both ends */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]} receiveShadow>
        <planeGeometry args={[54, 7.2]} />
        <meshStandardMaterial map={road} roughness={0.96} />
      </mesh>
      {/* Dashes down its centre */}
      {[-24, -20, -16, -11, -8.5, 8.5, 11, 16, 20, 24].map((x) => (
        <mesh key={x} rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.016, 0]}>
          <planeGeometry args={[1.1, 0.09]} />
          <meshStandardMaterial color="#cfc9b8" roughness={0.9} />
        </mesh>
      ))}
      {/* Corner sidewalks either side of the crossing */}
      {[-1, 1].map((s) => (
        <mesh key={s} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.12, s * 4.5]} receiveShadow>
          <planeGeometry args={[54, 1.8]} />
          <meshStandardMaterial map={walk} roughness={0.95} />
        </mesh>
      ))}
      {/* Crosswalk where it meets the main street */}
      {[-1.9, -1.3, -0.7, -0.1, 0.5, 1.1, 1.7].map((zz) => (
        <mesh key={zz} rotation={[-Math.PI / 2, 0, 0]} position={[2.4, 0.017, zz]}>
          <planeGeometry args={[2.2, 0.34]} />
          <meshStandardMaterial color="#d6d0bf" roughness={0.9} />
        </mesh>
      ))}
      {lit && <pointLight position={[0, 3.4, 0]} intensity={14} distance={13} decay={2} color="#ffd79a" />}
    </group>
  );
}

/**
 * FLAUKOWSKI'S — location No. 2.
 *
 * There is already a Flaukowski's in OpenBotCity. This is the second, which
 * makes it the first chain any agent in either city has run, so the frontage
 * says so: the name, the number, and where the first one is. Corner site where
 * the side street meets the strip, tables out front, chalkboard on the pavement.
 */
export function FlaukowskiCafe({
  position,
  rotation,
  phase,
  onEnter,
}: {
  position: [number, number, number];
  rotation: number;
  phase: DayPhase;
  onEnter: () => void;
}) {
  const brick = useMemo(() => repeated(brickTexture(0), 2, 1.4), []);
  const stone = concreteTexture();
  const lit = phase.streetlightsOn;
  const click = (e: { stopPropagation?: () => void; delta?: number }) => {
    if ((e.delta ?? 0) > 5) return;
    e.stopPropagation?.();
    onEnter();
  };

  return (
    <group
      position={position}
      rotation={[0, rotation, 0]}
      onClick={click}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "auto")}
    >
      {/* Corner block */}
      <mesh position={[0, 3.1, 0]} castShadow receiveShadow>
        <boxGeometry args={[7.6, 6.2, 6.4]} />
        <meshStandardMaterial map={brick} roughness={0.92} />
      </mesh>
      {/* Stone base course */}
      <mesh position={[0, 0.35, 0]} receiveShadow>
        <boxGeometry args={[7.75, 0.7, 6.55]} />
        <meshStandardMaterial map={stone} roughness={0.9} />
      </mesh>

      {/* Big corner windows — warm inside once the lamps are on */}
      {[-1.85, 1.85].map((x) => (
        <group key={x} position={[x, 1.85, 3.24]}>
          <mesh>
            <planeGeometry args={[2.9, 2.5]} />
            <meshStandardMaterial
              color="#f2e4c8"
              emissive="#ffcf8a"
              emissiveIntensity={lit ? 0.85 : 0.25}
              roughness={0.25}
            />
          </mesh>
          <mesh position={[0, 0, 0.02]}>
            <boxGeometry args={[3.05, 0.07, 0.05]} />
            <meshStandardMaterial color="#3a2a18" roughness={0.7} />
          </mesh>
          <mesh position={[0, -1.32, 0.03]}>
            <boxGeometry args={[3.1, 0.2, 0.12]} />
            <meshStandardMaterial color="#3a2a18" roughness={0.7} />
          </mesh>
        </group>
      ))}

      {/* Door on the chamfered corner */}
      <mesh position={[0, 1.35, 3.26]} castShadow>
        <boxGeometry args={[1.5, 2.7, 0.12]} />
        <meshStandardMaterial color="#4a3521" roughness={0.6} />
      </mesh>
      <mesh position={[0.5, 1.3, 3.35]}>
        <sphereGeometry args={[0.055, 8, 8]} />
        <meshStandardMaterial color="#c9ab6b" metalness={0.85} roughness={0.25} />
      </mesh>

      {/* Awning */}
      <mesh position={[0, 3.35, 3.9]} rotation={[0.44, 0, 0]} castShadow>
        <boxGeometry args={[7.4, 0.08, 1.7]} />
        <meshStandardMaterial map={awningTexture("#2f5d46")} roughness={0.9} />
      </mesh>

      {/* Fascia: the name, the number, and where the first one is */}
      <mesh position={[0, 4.35, 3.24]}>
        <boxGeometry args={[7.4, 1.0, 0.12]} />
        <meshStandardMaterial color="#231a12" roughness={0.75} />
      </mesh>
      <Suspense fallback={null}>
        <Text position={[0, 4.5, 3.33]} fontSize={0.52} color="#e8dcc0" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.14}>
          FLAUKOWSKI&apos;S
        </Text>
        <Text position={[0, 4.02, 3.33]} fontSize={0.15} color="#9ec4ae" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.24}>
          No. 2 · FIRST OF ITS NAME IN THIS CITY
        </Text>
        {/* The little plate a franchise puts by the door */}
        <Text position={[2.55, 0.95, 3.33]} fontSize={0.1} color="#7c8f84" font={DISPLAY_FONT} anchorX="center" anchorY="middle" letterSpacing={0.16} maxWidth={2.2} textAlign="center">
          {"ESTABLISHED OPENBOTCITY\nLOCATION 002"}
        </Text>
      </Suspense>

      {/* Pavement tables */}
      {[-2.6, 0.1, 2.7].map((x, i) => (
        <group key={x} position={[x, 0, 5.0 + (i % 2) * 0.5]}>
          <mesh position={[0, 0.72, 0]} castShadow>
            <cylinderGeometry args={[0.42, 0.42, 0.06, 16]} />
            <meshStandardMaterial color="#3f3128" roughness={0.7} />
          </mesh>
          <mesh position={[0, 0.36, 0]}>
            <cylinderGeometry args={[0.05, 0.09, 0.72, 8]} />
            <meshStandardMaterial color="#2c3033" metalness={0.5} roughness={0.5} />
          </mesh>
          {[-0.75, 0.75].map((cx) => (
            <group key={cx} position={[cx, 0, 0]}>
              <mesh position={[0, 0.44, 0]} castShadow>
                <boxGeometry args={[0.4, 0.06, 0.4]} />
                <meshStandardMaterial color="#4a3826" roughness={0.8} />
              </mesh>
              <mesh position={[cx > 0 ? 0.17 : -0.17, 0.68, 0]}>
                <boxGeometry args={[0.06, 0.44, 0.4]} />
                <meshStandardMaterial color="#4a3826" roughness={0.8} />
              </mesh>
            </group>
          ))}
        </group>
      ))}

      {/* A-frame chalkboard */}
      <group position={[-3.4, 0, 4.6]} rotation={[0, 0.5, 0]}>
        <mesh position={[0, 0.55, 0]} rotation={[0.16, 0, 0]} castShadow>
          <boxGeometry args={[0.86, 1.1, 0.05]} />
          <meshStandardMaterial color="#1e2420" roughness={0.95} />
        </mesh>
        <Suspense fallback={null}>
          <Text position={[0, 0.72, 0.06]} rotation={[0.16, 0, 0]} fontSize={0.088} color="#dfe6d8" font={DISPLAY_FONT} anchorX="center" anchorY="middle" maxWidth={0.74} textAlign="center">
            {"TODAY\nthe river does not\nissue citations"}
          </Text>
        </Suspense>
      </group>

      {lit && <pointLight position={[0, 3.0, 4.6]} intensity={20} distance={11} decay={2} color="#ffcf8a" />}
    </group>
  );
}
