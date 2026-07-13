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

/** Axis-aligned box footprint on the ground plane (for collision). */
export interface Obstacle {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
}

/**
 * First-person-ish WASD movement layered on top of OrbitControls: W/S glide
 * along the look direction, A/D strafe, R/F (or Space/Shift) rise/fall. The
 * camera and the orbit target move by the SAME resolved delta, so drag-look,
 * scroll-zoom and click-select all keep working (no pointer lock). Optional
 * `obstacles` block you from walking through buildings; `bounds` keep you in
 * the scene.
 */
export function WasdMove({
  controls,
  speed = 14,
  bounds,
  obstacles,
}: {
  controls: React.RefObject<MinimalControls>;
  speed?: number;
  bounds?: WasdBounds;
  obstacles?: Obstacle[];
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
    move.current.y += vert;
    move.current.multiplyScalar(speed * Math.min(dt, 0.05));

    // Candidate position, then resolve bounds + collision.
    let nx = camera.position.x + move.current.x;
    let ny = camera.position.y + move.current.y;
    let nz = camera.position.z + move.current.z;

    if (bounds) {
      nx = THREE.MathUtils.clamp(nx, bounds.minX, bounds.maxX);
      nz = THREE.MathUtils.clamp(nz, bounds.minZ, bounds.maxZ);
      ny = THREE.MathUtils.clamp(ny, bounds.minY ?? -Infinity, bounds.maxY ?? Infinity);
    }

    // Building collision (only while at street level — you can fly over tops).
    if (obstacles && ny < 7) {
      const pad = 0.5;
      for (const o of obstacles) {
        const dx = nx - o.cx;
        const dz = nz - o.cz;
        const px = o.hx + pad - Math.abs(dx);
        const pz = o.hz + pad - Math.abs(dz);
        if (px > 0 && pz > 0) {
          if (px < pz) nx = o.cx + Math.sign(dx || 1) * (o.hx + pad);
          else nz = o.cz + Math.sign(dz || 1) * (o.hz + pad);
        }
      }
    }

    // Apply the SAME resolved delta to camera and look target so orbit stays sane.
    const rdx = nx - camera.position.x;
    const rdy = ny - camera.position.y;
    const rdz = nz - camera.position.z;
    camera.position.set(nx, ny, nz);
    const c = controls.current;
    if (c) {
      c.target.x += rdx;
      c.target.y += rdy;
      c.target.z += rdz;
      c.update();
    }
  });

  return null;
}
