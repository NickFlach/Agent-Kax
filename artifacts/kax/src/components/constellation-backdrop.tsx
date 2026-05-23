/**
 * constellation-backdrop.tsx — rotating ambient background image picked
 * from the Kannaka constellation mirror (radio album covers, observatory
 * glyphs, etc.). Hits `GET /api/constellation/background` every refresh
 * cycle; the endpoint returns 204 when there are no candidates and the
 * SPA's CSS default takes over.
 *
 * Performance:
 *   - One image element + opacity crossfade — no canvas / WebGL.
 *   - Refreshes every BACKDROP_REFRESH_MS (5 minutes default).
 *   - Hidden when prefers-reduced-motion is true (no fade churn).
 *   - Hidden when the user is on the 3D marketplace; that page renders
 *     its own scene and the backdrop would compete visually.
 *
 * Failure mode: 204 / network error / non-image url leaves the existing
 * backdrop in place. Never throws.
 */

import { useEffect, useState } from "react";
import { useLocation } from "wouter";

const BACKDROP_REFRESH_MS = 5 * 60 * 1000;
const FADE_MS = 1800;

interface BackdropResponse {
  id: number;
  publicUrl: string;
  thumbnailUrl: string | null;
  title: string | null;
  originAgentId: string;
}

async function fetchOne(signal: AbortSignal): Promise<BackdropResponse | null> {
  try {
    const res = await fetch("/api/constellation/background", { signal });
    if (res.status === 204) return null;
    if (!res.ok) return null;
    const json = (await res.json()) as BackdropResponse;
    if (!json || typeof json.publicUrl !== "string") return null;
    return json;
  } catch {
    return null;
  }
}

export function ConstellationBackdrop() {
  const [location] = useLocation();
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [previousUrl, setPreviousUrl] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const reducedMotion = typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // Hide on the 3D marketplace; its scene fills the viewport.
  const hidden = location.startsWith("/marketplace");

  useEffect(() => {
    if (hidden) return;
    let cancelled = false;
    const ac = new AbortController();

    const refresh = async () => {
      const next = await fetchOne(ac.signal);
      if (cancelled || !next) return;
      setPreviousUrl(currentUrl);
      setCurrentUrl(next.publicUrl);
      setTitle(next.title ?? next.originAgentId);
    };

    void refresh();
    const interval = window.setInterval(() => void refresh(), BACKDROP_REFRESH_MS);
    return () => {
      cancelled = true;
      ac.abort();
      window.clearInterval(interval);
    };
    // currentUrl intentionally excluded; we re-render via state change after refresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden]);

  if (hidden || !currentUrl) return null;

  const transition = reducedMotion ? "none" : `opacity ${FADE_MS}ms ease-in-out`;

  return (
    <div
      aria-hidden
      title={title ?? undefined}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: -1,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      {previousUrl && previousUrl !== currentUrl && (
        <img
          src={previousUrl}
          alt=""
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: 0,
            transition,
            filter: "blur(28px) saturate(0.6)",
          }}
        />
      )}
      <img
        src={currentUrl}
        alt=""
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          opacity: 0.08,
          transition,
          filter: "blur(28px) saturate(0.6)",
        }}
      />
    </div>
  );
}
