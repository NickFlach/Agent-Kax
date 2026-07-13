import { useEffect, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";

type MinimalControls = { target: THREE.Vector3; update: () => void } | null;

export interface WasdBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY?: number;
  maxY?: number;
}

/**
 * First-person-ish WASD movement layered on top of OrbitControls: W/S glide
 * along the look direction, A/D strafe, R/F rise/fall — all on the horizontal
 * plane at the current height. Both the camera and the orbit target move
 * together, so drag-to-look and scroll-zoom keep working and clicking a store
 * still selects it (no pointer lock stealing the cursor).
 */
export function WasdMove({
  controls,
  speed = 14,
  bounds,
}: {
  controls: React.RefObject<MinimalControls>;
  speed?: number;
  bounds?: WasdBounds;
}) {
  const keys = useRef<Record<string, boolean>>({});
  const { camera } = useThree();

  useEffect(() => {
    const isTyping = () => {
      const el = document.activeElement;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (isTyping()) return;
      keys.current[e.code] = true;
    };
    const up = (e: KeyboardEvent) => {
      keys.current[e.code] = false;
    };
    const blur = () => (keys.current = {});
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const forward = useRef(new THREE.Vector3());
  const right = useRef(new THREE.Vector3());
  const move = useRef(new THREE.Vector3());

  useFrame((_, dt) => {
    const k = keys.current;
    const fwd = (k["KeyW"] || k["ArrowUp"] ? 1 : 0) - (k["KeyS"] || k["ArrowDown"] ? 1 : 0);
    const strafe = (k["KeyD"] || k["ArrowRight"] ? 1 : 0) - (k["KeyA"] || k["ArrowLeft"] ? 1 : 0);
    const vert = (k["KeyR"] || k["Space"] ? 1 : 0) - (k["KeyF"] || k["ShiftLeft"] ? 1 : 0);
    if (!fwd && !strafe && !vert) return;

    camera.getWorldDirection(forward.current);
    forward.current.y = 0;
    if (forward.current.lengthSq() < 1e-6) return;
    forward.current.normalize();
    right.current.crossVectors(forward.current, camera.up).normalize();

    move.current.set(0, 0, 0);
    move.current.addScaledVector(forward.current, fwd);
    move.current.addScaledVector(right.current, strafe);
    if (move.current.lengthSq() > 0) move.current.normalize();
    move.current.y += vert; // rise/fall independent of look
    move.current.multiplyScalar(speed * Math.min(dt, 0.05));

    camera.position.add(move.current);
    if (bounds) {
      camera.position.x = THREE.MathUtils.clamp(camera.position.x, bounds.minX, bounds.maxX);
      camera.position.z = THREE.MathUtils.clamp(camera.position.z, bounds.minZ, bounds.maxZ);
      if (bounds.minY != null || bounds.maxY != null) {
        camera.position.y = THREE.MathUtils.clamp(camera.position.y, bounds.minY ?? -Infinity, bounds.maxY ?? Infinity);
      }
    }
    const c = controls.current;
    if (c) {
      c.target.add(move.current);
      c.update();
    }
  });

  return null;
}
