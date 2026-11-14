"use client";

import { Html } from "@react-three/drei";
import type { Room } from "../lib/model";
import {
  WALL_HEIGHT,
  doorMarkers,
  roomCentre,
  wallSegments,
} from "../lib/geometry";

/** Faint functional tint, so rooms are distinguishable without labels. */
export const ROOM_TINT: Record<string, string> = {
  reception: "#ded0b4",
  planning: "#c9d4de",
  fulfilment: "#cbdcc6",
  finance: "#dfc9cd",
  operations: "#d2cbdf",
};

export function RoomMesh({
  room,
  highlight,
  onSelect,
}: {
  room: Room;
  /** Set when a task is halted in here. */
  highlight: "none" | "question" | "permission";
  onSelect: () => void;
}) {
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
          onSelect();
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
          position={[s.cx, WALL_HEIGHT / 2, s.cz]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[s.lx, WALL_HEIGHT, s.lz]} />
          <meshStandardMaterial color="#f1ede5" roughness={0.9} />
        </mesh>
      ))}

      {/* a lintel over each opening, so doorways read as doorways */}
      {doors.map((d) => (
        <mesh key={d.id} position={[d.cx, WALL_HEIGHT - 0.18, d.cz]}>
          <boxGeometry args={[0.46, 0.36, 0.46]} />
          <meshStandardMaterial
            color={d.exterior ? "#b9b2a4" : "#e4dfd5"}
            roughness={0.9}
          />
        </mesh>
      ))}

      {/* Annotation sits in a corner, clear of the desks. */}
      <Html
        position={[cx, 0.06, room.bounds.z + 0.95]}
        center
        distanceFactor={26}
        zIndexRange={[10, 0]}
      >
        <div className="room-label">
          <div className="name">{room.name}</div>
          <div className="purpose">{room.purpose}</div>
        </div>
      </Html>
    </group>
  );
}
