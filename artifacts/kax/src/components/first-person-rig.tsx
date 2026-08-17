import { useEffect, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { isTypingTarget } from "@/lib/is-typing";

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
  groundHeight,
  suspended = false,
}: {
  eyeHeight?: number;
  speed?: number;
  lookSpeed?: number;
  bounds?: FpsBounds;
  obstacles?: FpsObstacle[];
  scrollStep?: number;
  /** Optional spawn override — e.g. stepping out of the door you entered. */
  spawn?: FpsSpawn | null;
  /**
   * Stop the body while something else owns the visitor's attention.
   *
   * The checkout desk sets this for the whole of a charge, and the case it
   * exists for is a bank's 3D Secure challenge: Stripe renders that in a
   * cross-origin iframe over the canvas, and a player typing a one-time
   * passcode must not walk out of the shop while doing it. `isTypingTarget()`
   * now treats a focused IFRAME as typing, which stops the keystrokes being
   * read as movement — but it cannot stop keys that were already HELD when the
   * challenge opened, and it says nothing about the pointer. Both are closed
   * here: held keys are dropped on the rising edge, and the drag is ended.
   *
   * Only the movement half stops. Look orientation is still written every
   * frame, because the camera has to keep pointing where the player left it.
   */
  suspended?: boolean;
  /**
   * Optional terrain: ground elevation at (x,z). When provided the camera
   * stands eyeHeight above it every frame — this is what makes STAIRS work:
   * the stairwell reports a ramp height and walking up actually lifts you.
   * R/F flying is disabled while terrain is authoritative.
   */
  groundHeight?: (x: number, z: number) => number;
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

  /**
   * The suspension, readable from the event listeners without re-binding them.
   *
   * The listener effect below is keyed on `gl` and the two speeds precisely so
   * that it binds once for the life of the canvas. Adding `suspended` to its
   * dependencies would tear down and re-attach every handler at the exact
   * moment a payment starts, which is when the least should be moving.
   */
  const suspendedRef = useRef(suspended);
  useEffect(() => {
    suspendedRef.current = suspended;
    if (!suspended) return;
    // The rising edge, and everything mid-gesture with it. A key held when the
    // challenge opened would otherwise still be held when it closes, and a
    // pointer released over Stripe's own modal never reaches our `pointerup`.
    keys.current = {};
    dragging.current = false;
    scrollMove.current = 0;
  }, [suspended]);

  useEffect(() => {
    const el = gl.domElement;
    const down = (e: KeyboardEvent) => {
      if (isTypingTarget()) return;
      // Nothing is latched while the body is suspended. `isTypingTarget()` is
      // usually enough during a bank challenge, because Stripe's iframe holds
      // focus — but one click on the payment shield (an ordinary div) moves
      // focus to the body, and from then on a held W is recorded. `useFrame`
      // early-returns so nothing moves at the time, and the avatar lurches
      // across the shop the instant the charge finishes. Same reasoning that
      // already clears `scrollMove` in the suspended branch.
      if (suspendedRef.current) return;
      keys.current[e.code] = true;
    };
    // `keyup` is deliberately unconditional: a key released DURING a suspension
    // must still be cleared, or it is stranded as held when movement resumes.
    const up = (e: KeyboardEvent) => (keys.current[e.code] = false);
    const blur = () => (keys.current = {});

    const pDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // A press that lands on the canvas while suspended must not start a
      // look-drag. The panel puts a backdrop over the scene, so this is the
      // second lock rather than the first — and the one that still holds if a
      // caller suspends without covering anything.
      if (suspendedRef.current) return;
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

    // Terrain snap runs every frame (not just while moving) so a floor
    // teleport or elevator arrival lands you standing on the new ground.
    if (groundHeight) {
      camera.position.y = groundHeight(camera.position.x, camera.position.z) + eyeHeight;
    }

    // Move — unless something else owns the visitor right now.
    if (suspendedRef.current) {
      // Cleared rather than left to accumulate: a wheel turned during a bank
      // challenge would otherwise dolly the camera the instant the charge
      // finished, which reads as the room lurching on its own.
      scrollMove.current = 0;
      return;
    }

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

    // Terrain wins: stand on whatever the scene says is underfoot (stairs!).
    if (groundHeight) {
      ny = groundHeight(nx, nz) + eyeHeight;
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
