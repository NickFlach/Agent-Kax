import { useEffect, useState } from "react";
import * as THREE from "three";

/**
 * A work of art, hung or stood.
 *
 * The city shows agents' furniture in two places now — on a plinth in the
 * Joinery's showroom and standing in somebody's flat once they have bought it
 * — and both need the same thing: load a thumbnail, keep its aspect ratio, and
 * show a sensible blank while it arrives or if it never does.
 *
 * The blank matters more than it looks. A texture that fails to load leaves a
 * mesh with no map, which renders as a white rectangle that looks exactly like
 * a piece somebody made. Better to show an obviously unfinished panel than a
 * convincing wrong one.
 */

/** Load a thumbnail and report its aspect ratio. Null until it arrives. */
export function useThumbnailTexture(url: string | null | undefined): {
  texture: THREE.Texture | null;
  aspect: number;
} {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  const [aspect, setAspect] = useState(1);

  useEffect(() => {
    if (!url) {
      setTexture(null);
      return;
    }
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    let alive = true;
    loader.load(
      url,
      (t) => {
        if (!alive) return;
        t.colorSpace = THREE.SRGBColorSpace;
        const img = t.image as { width?: number; height?: number };
        if (img?.width && img?.height) setAspect(img.width / img.height);
        setTexture(t);
      },
      undefined,
      // A dead thumbnail is not an exception worth throwing — the caller
      // renders the blank panel and the room still works.
      () => {
        if (alive) setTexture(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [url]);

  return { texture, aspect };
}

export interface FramedPieceProps {
  thumbnailUrl: string | null;
  /** Width in metres; height follows the piece's own proportions. */
  width?: number;
  /** Clamp, so a very tall or very wide render still fits the wall it is on. */
  maxHeight?: number;
  minHeight?: number;
}

/**
 * The piece itself in a dark frame, centred on its own origin.
 *
 * Deliberately unlit (`meshBasicMaterial`, `toneMapped={false}`): these are
 * renders of furniture, not surfaces in the room, and letting the room's own
 * evening light dim them turns somebody's work into a grey smudge after dark.
 */
export function FramedPiece({
  thumbnailUrl,
  width = 1.5,
  maxHeight = 1.7,
  minHeight = 0.9,
}: FramedPieceProps) {
  const { texture, aspect } = useThumbnailTexture(thumbnailUrl);
  const h = Math.min(maxHeight, Math.max(minHeight, width / aspect));

  if (!texture) {
    return (
      <mesh>
        <boxGeometry args={[width, minHeight + 0.2, 0.04]} />
        <meshStandardMaterial color="#cec8bc" roughness={0.95} />
      </mesh>
    );
  }

  return (
    <group>
      <mesh position={[0, 0, -0.025]} castShadow>
        <boxGeometry args={[width + 0.12, h + 0.12, 0.04]} />
        <meshStandardMaterial color="#3a332c" roughness={0.6} />
      </mesh>
      <mesh>
        <planeGeometry args={[width, h]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** The height a FramedPiece will occupy, for callers that must place it. */
export function framedHeight(aspect: number, width = 1.5, maxHeight = 1.7, minHeight = 0.9): number {
  return Math.min(maxHeight, Math.max(minHeight, width / aspect));
}
