import { useEffect, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";

export interface FpsBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY?: number;
  maxY?: number;
}

/** Axis-aligned box footprint on the ground plane (for collision). */
export interface FpsObstacle {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
}

/**
 * First-person camera rig — the FPS feel the district was missing.
 *
 * OrbitControls orbited the camera around a distant target, so a drag swung
 * the viewpoint through space away from where you stood. This rig does what a
 * shooter does instead: dragging rotates the VIEW from the eye (yaw around Y,
 * pitch clamped), WASD walks along the look direction at a fixed eye height,
 * scroll steps you forward/back, R/F (or Space/Shift) adjusts eye height
 * within bounds. The camera position only changes when YOU move.
 *
 * Click-to-select keeps working because we never capture the pointer — R3F
 * events still raycast; handlers should ignore clicks with `e.delta > 5`
 * (a drag that ended on the object).
 */
export interface FpsSpawn {
  position: [number, number, number];
  /** Heading in radians — 0 faces -z, π faces +z, -π/2 faces +x. */
  yaw: number;
}

export function FirstPersonRig({
  eyeHeight = 1.75,
  speed = 10,
  lookSpeed = 0.0032,
  bounds,
  obstacles,
  scrollStep = 2.2,
  spawn,
}: {
  eyeHeight?: number;
  speed?: number;
  lookSpeed?: number;
  bounds?: FpsBounds;
  obstacles?: FpsObstacle[];
  scrollStep?: number;
  /** Optional spawn override — e.g. stepping out of the door you entered. */
  spawn?: FpsSpawn | null;
}) {
  const { camera, gl } = useThree();
  const keys = useRef<Record<string, boolean>>({});
  const yaw = useRef(0);
  const pitch = useRef(0);
  const dragging = useRef(false);
  const last = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const scrollMove = useRef(0);

  // Adopt the camera's initial orientation once, then own it.
  useEffect(() => {
    camera.rotation.order = "YXZ";
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    yaw.current = Math.atan2(-dir.x, -dir.z);
    pitch.current = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    // Stand at eye height from wherever the scene placed us.
    camera.position.y = Math.max(camera.position.y, eyeHeight);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);

  // Spawn override — used to step out of the door you actually exited.
  useEffect(() => {
    if (!spawn) return;
    camera.position.set(spawn.position[0], Math.max(spawn.position[1], eyeHeight), spawn.position[2]);
    yaw.current = spawn.yaw;
    pitch.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spawn, camera]);

  useEffect(() => {
    const el = gl.domElement;
    const isTyping = () => {
      const a = document.activeElement;
      return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || (a as HTMLElement).isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (isTyping()) return;
      keys.current[e.code] = true;
    };
    const up = (e: KeyboardEvent) => (keys.current[e.code] = false);
    const blur = () => (keys.current = {});

    const pDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging.current = true;
      last.current = { x: e.clientX, y: e.clientY };
    };
    const pMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - last.current.x;
      const dy = e.clientY - last.current.y;
      last.current = { x: e.clientX, y: e.clientY };
      yaw.current -= dx * lookSpeed;
      pitch.current = THREE.MathUtils.clamp(pitch.current - dy * lookSpeed, -1.35, 1.35);
    };
    const pUp = () => (dragging.current = false);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      scrollMove.current += e.deltaY < 0 ? scrollStep : -scrollStep;
    };

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    el.addEventListener("pointerdown", pDown);
    window.addEventListener("pointermove", pMove);
    window.addEventListener("pointerup", pUp);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      el.removeEventListener("pointerdown", pDown);
      window.removeEventListener("pointermove", pMove);
      window.removeEventListener("pointerup", pUp);
      el.removeEventListener("wheel", wheel);
    };
  }, [gl, lookSpeed, scrollStep]);

  const fwdV = useRef(new THREE.Vector3());
  const rightV = useRef(new THREE.Vector3());
  const move = useRef(new THREE.Vector3());

  useFrame((_, dt) => {
    // Look
    camera.rotation.set(pitch.current, yaw.current, 0, "YXZ");

    // Move
    const k = keys.current;
    const fwd = (k["KeyW"] || k["ArrowUp"] ? 1 : 0) - (k["KeyS"] || k["ArrowDown"] ? 1 : 0);
    const strafe = (k["KeyD"] || k["ArrowRight"] ? 1 : 0) - (k["KeyA"] || k["ArrowLeft"] ? 1 : 0);
    const vert = (k["KeyR"] || k["Space"] ? 1 : 0) - (k["KeyF"] || k["ShiftLeft"] ? 1 : 0);
    const dolly = scrollMove.current;
    scrollMove.current = 0;
    if (!fwd && !strafe && !vert && !dolly) return;

    // Walk on the ground plane regardless of pitch (shooter-style).
    fwdV.current.set(-Math.sin(yaw.current), 0, -Math.cos(yaw.current));
    rightV.current.set(-fwdV.current.z, 0, fwdV.current.x);

    move.current.set(0, 0, 0);
    move.current.addScaledVector(fwdV.current, fwd);
    move.current.addScaledVector(rightV.current, strafe);
    if (move.current.lengthSq() > 0) move.current.normalize();
    move.current.multiplyScalar(speed * Math.min(dt, 0.05));
    move.current.addScaledVector(fwdV.current, dolly);

    let nx = camera.position.x + move.current.x;
    let nz = camera.position.z + move.current.z;
    let ny = camera.position.y + vert * speed * 0.6 * Math.min(dt, 0.05);

    if (bounds) {
      nx = THREE.MathUtils.clamp(nx, bounds.minX, bounds.maxX);
      nz = THREE.MathUtils.clamp(nz, bounds.minZ, bounds.maxZ);
      ny = THREE.MathUtils.clamp(ny, bounds.minY ?? eyeHeight, bounds.maxY ?? Infinity);
    } else {
      ny = Math.max(ny, eyeHeight);
    }

    // Building collision (skips while flying above the rooftops).
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

    camera.position.set(nx, ny, nz);
  });

  return null;
}
