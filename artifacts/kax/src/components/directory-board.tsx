import { Suspense, useEffect, useState } from "react";
import { Text } from "@react-three/drei";
import { DISPLAY_FONT } from "@/lib/fonts";
import { layoutBoard, overflowLine, type BoardRoom } from "@/lib/directory-board";

/**
 * A standing directory board — what is in this city, and who is in it now.
 *
 * The player spawns facing 157 units of street with no sign anywhere and the
 * anchors 110 units away. This is the answer to "what is here", readable by
 * looking rather than by opening a menu.
 *
 * Occupancy comes from GET /api/city/rooms, which already returns `here` per
 * room. A board that showed only names would be a map; one that shows who is
 * in each room is a reason to walk somewhere, which is the point.
 *
 * Rooms are fetched once per mount and refreshed on a slow interval. A sign is
 * not a live feed, and a board repainting every second in the corner of the
 * street would pull the eye away from the city rather than into it.
 */

const REFRESH_MS = 30_000;

export function useCityRooms(): BoardRoom[] {
  const [rooms, setRooms] = useState<BoardRoom[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch("/api/city/rooms")
        .then((r) => (r.ok ? r.json() : { rooms: [] }))
        .then((j: { rooms?: BoardRoom[] }) => {
          if (alive) setRooms(j.rooms ?? []);
        })
        // A board that cannot reach the city shows its frame and no lines,
        // which reads as "not loaded" rather than as "the city is empty".
        .catch(() => undefined);
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return rooms;
}

export interface DirectoryBoardProps {
  position: [number, number, number];
  /** Y rotation, so a board can face the way somebody is walking. */
  rotation?: number;
  rooms: BoardRoom[];
  /** Shown across the top. The street mouth says something different to a corner. */
  heading?: string;
}

export function DirectoryBoard({ position, rotation = 0, rooms, heading = "KAX CITY" }: DirectoryBoardProps) {
  const board = layoutBoard(rooms);
  const width = 2.1;

  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {/* Two posts and a panel — a noticeboard, not a screen. */}
      {[-width / 2 + 0.12, width / 2 - 0.12].map((x) => (
        <mesh key={x} position={[x, 0.9, 0]} castShadow>
          <boxGeometry args={[0.09, 1.8, 0.09]} />
          <meshStandardMaterial color="#3a352d" roughness={0.7} metalness={0.2} />
        </mesh>
      ))}
      <mesh position={[0, 1.85 + board.height / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width, board.height, 0.09]} />
        <meshStandardMaterial color="#e8e2d4" roughness={0.9} />
      </mesh>
      {/* A darker rail under the heading, so the eye finds the top first. */}
      <mesh position={[0, 1.85 + board.height - 0.42, 0.05]}>
        <boxGeometry args={[width - 0.16, 0.02, 0.01]} />
        <meshStandardMaterial color="#8a8272" />
      </mesh>

      <group position={[0, 1.85 + board.height / 2, 0.055]}>
        {/* Every label in its own boundary: drei Text suspends on the font,
            and an unguarded one holds back the whole sign. */}
        <Suspense fallback={null}>
          <Text
            position={[0, board.height / 2 - 0.3, 0]}
            fontSize={0.15}
            color="#2f2a24"
            font={DISPLAY_FONT}
            anchorX="center"
            anchorY="middle"
            letterSpacing={0.18}
          >
            {heading}
          </Text>
        </Suspense>

        {board.lines.map((line, i) => (
          <Suspense key={line.id} fallback={null}>
            <Text
              position={[-width / 2 + 0.16, board.firstLineY - i * 0.26, 0]}
              fontSize={0.108}
              color="#3f3a33"
              font={DISPLAY_FONT}
              anchorX="left"
              anchorY="middle"
            >
              {line.text}
            </Text>
            <Text
              position={[width / 2 - 0.16, board.firstLineY - i * 0.26, 0]}
              fontSize={0.1}
              color={line.here > 0 ? "#7a5c2a" : "#a9a294"}
              font={DISPLAY_FONT}
              anchorX="right"
              anchorY="middle"
            >
              {line.here > 0 ? String(line.here) : "·"}
            </Text>
          </Suspense>
        ))}

        {board.overflow > 0 && (
          <Suspense fallback={null}>
            <Text
              position={[-width / 2 + 0.16, board.firstLineY - board.lines.length * 0.26, 0]}
              fontSize={0.095}
              color="#8a8272"
              font={DISPLAY_FONT}
              anchorX="left"
              anchorY="middle"
            >
              {overflowLine(board.overflow)}
            </Text>
          </Suspense>
        )}
      </group>
    </group>
  );
}

/** The footprint a board occupies, for the obstacle list. */
export const BOARD_FOOTPRINT = { hx: 1.15, hz: 0.35 };
