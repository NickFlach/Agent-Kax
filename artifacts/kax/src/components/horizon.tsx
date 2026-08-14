import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { mountainRidgeTexture, oceanTexture } from "@/lib/city-textures";
import type { DayPhase } from "@/lib/time-of-day";

/**
 * What the city sits in — the land it occupies, seen from high up.
 *
 * East (+X) the ground climbs into snow-capped ranges, drawn as billboard
 * ridges at increasing distance and haze so depth reads without geometry.
 * West (-X) it runs out into open ocean, and when the sun is low the water
 * carries a glitter path back toward the viewer.
 *
 * Geometry is arranged around the EYE, not the ground: the sea sits far enough
 * out that its far edge lands within a degree of eye level, which is what makes
 * it read as a horizon rather than as a floor. The ranges stand on that same
 * line. Everything is unlit (basic materials) and fog-exempt, so the scenery
 * cannot be washed to white by a room's interior lighting.
 */

const SEA_Y = -34;      // sea level relative to the room floor
const FAR = 1500;       // distance to the ranges
const SEA_REACH = 4200; // how far the water runs before the far edge

export function Horizon({ phase }: { phase: DayPhase }) {
  const ocean = useMemo(() => {
    const t = oceanTexture().clone() as THREE.CanvasTexture;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(60, 60);
    t.needsUpdate = true;
    return t;
  }, []);

  const ridges = useMemo(
    () => [
      { tex: mountainRidgeTexture({ seed: 3, haze: 0.5, snowLine: 0.34 }), d: 1.0, h: 520 },
      { tex: mountainRidgeTexture({ seed: 11, haze: 0.3, snowLine: 0.44 }), d: 0.82, h: 420 },
      { tex: mountainRidgeTexture({ seed: 27, haze: 0.12, snowLine: 0.54, rock: "#4a566b" }), d: 0.66, h: 330 },
    ],
    [],
  );

  const seaRef = useRef<THREE.MeshBasicMaterial>(null);
  useFrame((_, dt) => {
    ocean.offset.x += dt * 0.003;
    ocean.offset.y += dt * 0.0016;
    if (seaRef.current) {
      // The sea takes its colour from the sky rather than a fixed blue.
      seaRef.current.color.set(
        phase.isNight ? "#0a1626" : phase.elevation < 0.22 ? "#2f5170" : "#2b5a80",
      );
    }
  });

  const glitter = !phase.isNight && phase.elevation < 0.34
    ? 0.55 * (1 - Math.min(1, Math.abs(phase.elevation - 0.08) / 0.3))
    : 0;

  return (
    <group renderOrder={-20}>
      {/* ---- WEST: open water, running out to the horizon line ---- */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-SEA_REACH / 2, SEA_Y, 0]}>
        <planeGeometry args={[SEA_REACH, SEA_REACH * 1.6]} />
        <meshBasicMaterial ref={seaRef} map={ocean} fog={false} toneMapped={false} />
      </mesh>
      {glitter > 0.02 && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-SEA_REACH / 2, SEA_Y + 0.5, 0]}>
          <planeGeometry args={[SEA_REACH, 220]} />
          <meshBasicMaterial
            color={phase.sunColor}
            transparent
            opacity={glitter}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            fog={false}
            toneMapped={false}
          />
        </mesh>
      )}

      {/* ---- EAST: land carrying the eye out to the foot of the ranges ---- */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[FAR * 0.9, SEA_Y + 0.4, 0]}>
        <planeGeometry args={[FAR * 2.6, FAR * 4]} />
        <meshBasicMaterial
          color={phase.isNight ? "#141c26" : phase.elevation < 0.25 ? "#5d6a63" : "#6b7a66"}
          fog={false}
          toneMapped={false}
        />
      </mesh>

      {/* ---- EAST: the ranges, standing on the same line ---- */}
      {ridges.map((r, i) => (
        <mesh
          key={`e${i}`}
          position={[FAR * r.d, SEA_Y + r.h * 0.42, 0]}
          rotation={[0, -Math.PI / 2, 0]}
        >
          <planeGeometry args={[FAR * 3.4, r.h]} />
          <meshBasicMaterial map={r.tex} transparent depthWrite={false} fog={false} toneMapped={false} />
        </mesh>
      ))}
      {/* North and south flanks so the land wraps rather than ending in space. */}
      {ridges.slice(0, 2).map((r, i) => (
        <mesh key={`n${i}`} position={[0, SEA_Y + r.h * 0.36, -FAR * r.d]}>
          <planeGeometry args={[FAR * 3.0, r.h * 0.8]} />
          <meshBasicMaterial map={r.tex} transparent depthWrite={false} fog={false} toneMapped={false} />
        </mesh>
      ))}
      {ridges.slice(0, 1).map((r, i) => (
        <mesh key={`s${i}`} position={[0, SEA_Y + r.h * 0.3, FAR * r.d]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[FAR * 3.0, r.h * 0.66]} />
          <meshBasicMaterial map={r.tex} transparent depthWrite={false} fog={false} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
