import { useEffect, useState } from "react";
import * as THREE from "three";

/**
 * The city runs on the visitor's own clock.
 *
 * Every scene asks this module what time it is in the browser's local zone and
 * gets back a sun, a palette and a verdict on whether the streetlights should
 * be burning. Nothing here is random or animated on a loop — walk in at 07:00
 * and the sun is low in the east; come back at 19:30 and it is going down over
 * the water. Two visitors in different time zones see different cities at the
 * same instant, which is the point.
 *
 * Orientation, fixed across every scene so the world stays coherent:
 *   +X is EAST   — sunrise, and the snow line beyond it
 *   -X is WEST   — sunset, and the ocean
 *   -Z is NORTH  — the street runs away from the entrance
 */

export const SUNRISE_H = 6;
export const SUNSET_H = 19;
const DAY_SPAN = SUNSET_H - SUNRISE_H;

export interface DayPhase {
  /** Local hour with minutes as a fraction, 0–24. */
  hour: number;
  /** 0 at sunrise, 1 at sunset; outside [0,1] when the sun is down. */
  dayProgress: number;
  /** Sun elevation, -1 (midnight) … 1 (noon). */
  elevation: number;
  /** World-space sun direction, already scaled for `<Sky sunPosition>`. */
  sunPosition: [number, number, number];
  isNight: boolean;
  /** Streetlights burn from dusk to dawn. */
  streetlightsOn: boolean;
  /** How lit windows read — full at night, off at midday. */
  windowGlow: number;
  sunIntensity: number;
  ambientIntensity: number;
  hemiIntensity: number;
  /** Warm at the ends of the day, white at noon, blue at night. */
  sunColor: string;
  ambientColor: string;
  skyGroundColor: string;
  fogColor: string;
  fogNear: number;
  fogFar: number;
  /** drei <Sky> tuning. */
  turbidity: number;
  rayleigh: number;
  /** Label for HUDs: "07:42 · morning". */
  label: string;
  phaseName: "night" | "dawn" | "morning" | "midday" | "afternoon" | "dusk";
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function clamp01(v: number) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** Mix two hex colours in linear-ish space; good enough for sky tints. */
function mixHex(a: string, b: string, t: number): string {
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  return "#" + ca.lerp(cb, clamp01(t)).getHexString();
}

/** Local hour (0–24) from a Date — defaults to the visitor's real clock. */
export function localHour(now: Date = new Date()): number {
  return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
}

export function phaseNameFor(hour: number): DayPhase["phaseName"] {
  if (hour < SUNRISE_H - 1 || hour >= SUNSET_H + 1) return "night";
  if (hour < SUNRISE_H + 1.5) return "dawn";
  if (hour < 11) return "morning";
  if (hour < 15) return "midday";
  if (hour < SUNSET_H - 1.5) return "afternoon";
  return "dusk";
}

export function getDayPhase(now: Date = new Date()): DayPhase {
  const hour = localHour(now);
  const dayProgress = (hour - SUNRISE_H) / DAY_SPAN;

  // Elevation: a half-sine across the daylight span, negative at night. The
  // night curve is shallow so moonlight stays believable rather than pitch black.
  let elevation: number;
  if (dayProgress >= 0 && dayProgress <= 1) {
    elevation = Math.sin(dayProgress * Math.PI);
  } else {
    const nightT = dayProgress < 0 ? (hour + 24 - SUNSET_H) / (24 - DAY_SPAN) : (hour - SUNSET_H) / (24 - DAY_SPAN);
    elevation = -0.55 * Math.sin(clamp01(nightT) * Math.PI);
  }

  // Azimuth sweeps east → west across the day; at night keep it below the
  // horizon on the far side so the sky stays dark and directionless.
  const R = 90;
  const az = Math.PI * clamp01(dayProgress);       // 0 = east, π = west
  const sunX = Math.cos(az) * R;
  const sunY = elevation * R * 0.8;
  const sunZ = -R * 0.3;                            // a constant southerly tilt

  const isNight = elevation <= 0.02;
  // Lights come on as the sun touches the horizon, not abruptly at a clock time.
  const dusk = clamp01((0.16 - elevation) / 0.16);
  const streetlightsOn = elevation < 0.12;
  const windowGlow = dusk;

  const day = clamp01(elevation / 0.55);            // 0 at horizon, 1 high up
  const goldenness = clamp01(1 - Math.abs(elevation - 0.2) / 0.35);

  const sunColor = isNight
    ? "#8fa6d8"
    : mixHex(mixHex("#ff9a4d", "#ffd9a8", clamp01(elevation / 0.35)), "#fff4e2", day);
  const ambientColor = isNight ? "#38507f" : mixHex("#ffd2a0", "#fff3e0", day);
  const skyGroundColor = isNight ? "#141a2c" : mixHex("#7a6a52", "#8a8272", day);
  const fogColor = isNight
    ? "#0b1020"
    : mixHex(mixHex("#f0b07a", "#e8d6c2", clamp01(elevation / 0.3)), "#cfd8de", day);

  return {
    hour,
    dayProgress,
    elevation,
    sunPosition: [sunX, sunY, sunZ],
    isNight,
    streetlightsOn,
    windowGlow,
    sunIntensity: isNight ? 0.12 : lerp(0.55, 1.9, day) * lerp(1, 1.15, goldenness),
    ambientIntensity: isNight ? 0.2 : lerp(0.22, 0.34, day),
    hemiIntensity: isNight ? 0.28 : lerp(0.5, 0.8, day),
    sunColor,
    ambientColor,
    skyGroundColor,
    fogColor,
    fogNear: isNight ? 26 : 34,
    fogFar: isNight ? 150 : 200,
    turbidity: isNight ? 12 : lerp(9, 4.5, day),
    rayleigh: isNight ? 0.35 : lerp(3.2, 1.6, day),
    label:
      String(Math.floor(hour)).padStart(2, "0") + ":" +
      String(Math.floor((hour % 1) * 60)).padStart(2, "0") +
      " · " + phaseNameFor(hour),
    phaseName: phaseNameFor(hour),
  };
}

/**
 * React helper: the current phase, refreshed on an interval.
 * A minute is plenty — the sun moves 0.25° in that time.
 */
export function useDayPhase(refreshMs = 60000): DayPhase {
  const [phase, setPhase] = useState(() => getDayPhase());
  useEffect(() => {
    const t = setInterval(() => setPhase(getDayPhase()), refreshMs);
    return () => clearInterval(t);
  }, [refreshMs]);
  return phase;
}
