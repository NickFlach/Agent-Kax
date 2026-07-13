import { useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";

/**
 * A small low-poly humanoid. Rendered at its parent group's origin; callers
 * position/rotate it. `idle` adds a gentle breathing bob.
 */
export function NpcFigure({ color, idle = true, scale = 1 }: { color: string; idle?: boolean; scale?: number }) {
  const g = useRef<THREE.Group>(null);
  const phase = useRef(Math.random() * Math.PI * 2);
  useFrame((s) => {
    if (idle && g.current) g.current.position.y = Math.sin(s.clock.elapsedTime * 1.6 + phase.current) * 0.04;
  });
  return (
    <group ref={g} scale={scale}>
      {/* legs */}
      <mesh position={[0, 0.45, 0]}>
        <cylinderGeometry args={[0.13, 0.16, 0.9, 8]} />
        <meshStandardMaterial color="#0e2a30" roughness={0.6} metalness={0.2} />
      </mesh>
      {/* torso */}
      <mesh position={[0, 1.15, 0]}>
        <cylinderGeometry args={[0.24, 0.2, 0.72, 10]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.3} roughness={0.5} />
      </mesh>
      {/* head */}
      <mesh position={[0, 1.68, 0]}>
        <sphereGeometry args={[0.19, 14, 14]} />
        <meshStandardMaterial color="#0d242a" emissive={color} emissiveIntensity={0.45} />
      </mesh>
    </group>
  );
}

/** An NPC that strolls up and down a straight stretch of the boulevard. */
export function WandererNpc({
  x,
  zNear,
  zFar,
  speed,
  offset,
  color,
}: {
  x: number;
  zNear: number;
  zFar: number;
  speed: number;
  offset: number;
  color: string;
}) {
  const g = useRef<THREE.Group>(null);
  const t = useRef(offset);
  useFrame((_, dt) => {
    if (!g.current) return;
    t.current += dt * speed;
    // triangle wave 0..1..0 for a ping-pong walk
    const tri = 1 - Math.abs((t.current % 2) - 1);
    const z = zNear + (zFar - zNear) * tri;
    g.current.position.set(x, 0, z);
    g.current.rotation.y = t.current % 2 < 1 ? 0 : Math.PI; // face travel direction
  });
  return (
    <group ref={g}>
      <NpcFigure color={color} idle={false} />
    </group>
  );
}

/** The player's own body, placed at the camera's ground position. Headless so
 *  the camera (at eye height) never clips into it. */
export function PlayerAvatar({ color = "#00e5ff" }: { color?: string }) {
  const g = useRef<THREE.Group>(null);
  const { camera } = useThree();
  const dir = useRef(new THREE.Vector3());
  useFrame(() => {
    if (!g.current) return;
    g.current.position.set(camera.position.x, 0, camera.position.z);
    camera.getWorldDirection(dir.current);
    g.current.rotation.y = Math.atan2(dir.current.x, dir.current.z);
  });
  return (
    <group ref={g}>
      <mesh position={[0, 0.45, 0]}>
        <cylinderGeometry args={[0.15, 0.18, 0.9, 8]} />
        <meshStandardMaterial color="#0E3A40" roughness={0.5} metalness={0.3} />
      </mesh>
      <mesh position={[0, 1.1, 0]}>
        <cylinderGeometry args={[0.26, 0.21, 0.7, 10]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
      </mesh>
    </group>
  );
}

/** Reports the camera's ground position + heading to the HUD (throttled) for a minimap. */
export function PlayerTracker({ onUpdate }: { onUpdate: (p: { x: number; z: number; h: number }) => void }) {
  const { camera } = useThree();
  const last = useRef(0);
  const dir = useRef(new THREE.Vector3());
  useFrame((s) => {
    if (s.clock.elapsedTime - last.current < 0.15) return;
    last.current = s.clock.elapsedTime;
    camera.getWorldDirection(dir.current);
    onUpdate({ x: camera.position.x, z: camera.position.z, h: Math.atan2(dir.current.x, dir.current.z) });
  });
  return null;
}
