"use client";

import type { Door, Room } from "../lib/model";
import {
  INSET,
  WALL_HEIGHT,
  WALL_THICK,
  doorCentre,
  doorMarkers,
  roomCentre,
  wallSegments,
} from "../lib/geometry";
import { SCENE_FONT, useCanvasTexture } from "./textTexture";

/** Faint functional tint, so rooms are distinguishable without labels. */
export const ROOM_TINT: Record<string, string> = {
  reception: "#ded0b4",
  planning: "#c9d4de",
  fulfilment: "#cbdcc6",
  finance: "#dfc9cd",
  operations: "#d2cbdf",
  hall: "#d6d2c8",
};

/** Walls rise to room height when the viewer is standing inside them. */
const WALK_WALL_HEIGHT = 2.5;
const DOOR_HEIGHT = 2.05;
/** A press that travelled further than this was a drag, so it selects nothing. */
export const CLICK_SLOP = 5;

/** Which way a wall faces, looking out of its room, as a turn about the vertical. */
const OUTWARD: Record<Door["wall"], { x: number; z: number; turn: number }> = {
  north: { x: 0, z: 1, turn: 0 },
  south: { x: 0, z: -1, turn: Math.PI },
  east: { x: 1, z: 0, turn: Math.PI / 2 },
  west: { x: -1, z: 0, turn: -Math.PI / 2 },
};

/**
 * The room's name above one of its doorways, on the side you approach from.
 * It hangs on the outer face of whatever closes over the opening there: the
 * neighbouring room's wall, or this room's own where the door leads outside.
 */
function NamePlate({ room, door, wallHeight }: { room: Room; door: Door; wallHeight: number }) {
  const { cx, cz } = doorCentre(room, door);
  const out = OUTWARD[door.wall];
  const reach = (door.toRoomId === null ? 0 : INSET * 2) + WALL_THICK / 2 + 0.012;
  // No wider than the opening and a little shorter than what closes over it.
  const width = Math.min(door.width - 0.1, 1.5);
  const height = Math.min(0.28, wallHeight - DOOR_HEIGHT - 0.12);
  const texture = useCanvasTexture(512, Math.round((512 * height) / width), room.name, (c) => {
    const h = c.canvas.height;
    c.fillStyle = "#1c2027";
    c.fillRect(0, 0, 512, h);
    c.fillStyle = "#e8e6e1";
    c.textAlign = "center";
    c.textBaseline = "middle";
    let size = Math.round(h * 0.6);
    c.font = `600 ${size}px ${SCENE_FONT}`;
    while (c.measureText(room.name).width > 470 && size > 14) {
      size -= 2;
      c.font = `600 ${size}px ${SCENE_FONT}`;
    }
    c.fillText(room.name, 256, h / 2 + 1);
  });
  return (
    <mesh position={[cx + out.x * reach, (DOOR_HEIGHT + wallHeight) / 2, cz + out.z * reach]} rotation={[0, out.turn, 0]}>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}

/**
 * What a person sees in a doorway they may not go through: a red pane across
 * the opening, readable from both sides.
 */
function Barrier({ room, door }: { room: Room; door: Door }) {
  const { cx, cz } = doorCentre(room, door);
  const out = OUTWARD[door.wall];
  const texture = useCanvasTexture(384, 560, "not-authorized", (c) => {
    c.clearRect(0, 0, 384, 560);
    c.fillStyle = "rgba(214, 58, 44, 0.3)";
    c.fillRect(0, 0, 384, 560);
    c.strokeStyle = "rgba(255, 214, 208, 0.85)";
    c.lineWidth = 8;
    c.strokeRect(10, 10, 364, 540);
    c.fillStyle = "#ffffff";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.font = `700 50px ${SCENE_FONT}`;
    c.fillText("Not", 192, 250);
    c.fillText("Authorized", 192, 312);
  });
  // The pane sits in the gap between the two rooms' walls, one face each way.
  const middle = door.toRoomId === null ? 0 : INSET;
  return (
    <>
      {[0, Math.PI].map((flip) => (
        <mesh
          key={flip}
          position={[cx + out.x * middle, DOOR_HEIGHT / 2, cz + out.z * middle]}
          rotation={[0, out.turn + flip, 0]}
        >
          <planeGeometry args={[door.width, DOOR_HEIGHT]} />
          <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
    </>
  );
}

export function RoomMesh({
  room,
  highlight,
  walking,
  barred,
  onSelect,
}: {
  room: Room;
  /** True when the person looking may not enter this room. */
  barred: boolean;
  /** Set when a task is halted in here. */
  highlight: "none" | "question" | "permission";
  walking: boolean;
  onSelect: () => void;
}) {
  const wallHeight = walking ? WALK_WALL_HEIGHT : WALL_HEIGHT;
  const segments = wallSegments(room);
  const doors = doorMarkers(room);
  const { cx, cz } = roomCentre(room);
  const tint = ROOM_TINT[room.id] ?? "#d4d0c8";

  const glow =
    highlight === "permission"
      ? "#e0614f"
      : highlight === "question"
        ? "#e0a23f"
        : null;

  return (
    <group>
      {/* floor */}
      <mesh
        position={[cx, 0, cz]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
        onClick={(e) => {
          e.stopPropagation();
          if (e.delta <= CLICK_SLOP) onSelect();
        }}
      >
        <planeGeometry args={[room.bounds.w - 0.2, room.bounds.d - 0.2]} />
        <meshStandardMaterial color={tint} roughness={0.95} />
      </mesh>

      {/* A halted task washes the room and draws a frame inside its walls. */}
      {glow && (
        <>
          <mesh position={[cx, 0.012, cz]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[room.bounds.w - 0.2, room.bounds.d - 0.2]} />
            <meshBasicMaterial color={glow} transparent opacity={0.3} />
          </mesh>
          {[
            [cx, room.bounds.z + 0.45, room.bounds.w - 1.0, 0.1],
            [cx, room.bounds.z + room.bounds.d - 0.45, room.bounds.w - 1.0, 0.1],
            [room.bounds.x + 0.45, cz, 0.1, room.bounds.d - 1.0],
            [room.bounds.x + room.bounds.w - 0.45, cz, 0.1, room.bounds.d - 1.0],
          ].map(([bx, bz, bw, bd], i) => (
            <mesh key={i} position={[bx, 0.03, bz]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[bw, bd]} />
              <meshBasicMaterial color={glow} transparent opacity={0.85} />
            </mesh>
          ))}
        </>
      )}

      {/* walls, already carved around the doorways */}
      {segments.map((s) => (
        <mesh
          key={s.id}
          position={[s.cx, wallHeight / 2, s.cz]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[s.lx, wallHeight, s.lz]} />
          <meshStandardMaterial color="#f1ede5" roughness={0.9} />
        </mesh>
      ))}

      {/* From above, a block marks each opening. On foot, the wall closes over it. */}
      {doors.map((d) =>
        walking ? (
          <mesh key={d.id} position={[d.cx, (DOOR_HEIGHT + wallHeight) / 2, d.cz]}>
            <boxGeometry
              args={[
                d.alongX ? d.width : WALL_THICK,
                wallHeight - DOOR_HEIGHT,
                d.alongX ? WALL_THICK : d.width,
              ]}
            />
            <meshStandardMaterial
              color={d.exterior ? "#b9b2a4" : "#e4dfd5"}
              roughness={0.9}
            />
          </mesh>
        ) : (
          <mesh key={d.id} position={[d.cx, wallHeight - 0.18, d.cz]}>
            <boxGeometry args={[0.46, 0.36, 0.46]} />
            <meshStandardMaterial
              color={d.exterior ? "#b9b2a4" : "#e4dfd5"}
              roughness={0.9}
            />
          </mesh>
        ),
      )}

      {/* On foot: the room's name over each doorway, and a barrier where the way is closed. */}
      {walking && room.doors.map((door) => <NamePlate key={door.id} room={room} door={door} wallHeight={wallHeight} />)}
      {walking && barred && room.doors.map((door) => <Barrier key={door.id} room={room} door={door} />)}
    </group>
  );
}
