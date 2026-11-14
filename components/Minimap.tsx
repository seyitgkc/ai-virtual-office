"use client";

import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import type { Office } from "../lib/model";
import {
  planExtent,
  seatPosition,
  wallSegments,
  type WalkPose,
} from "../lib/geometry";
import { ROOM_TINT } from "./RoomMesh";

const MARGIN = 2.8;
const HALT_COLOUR = { question: "#e0a23f", permission: "#e0614f" } as const;

/**
 * Top-down plan with the walker's position and heading. Drawn in world units
 * (metres), oriented like the overview: low z at the top.
 */
export function Minimap({
  office,
  pose,
  currentRoomId,
  roomHighlight,
  participantAlert,
}: {
  office: Office;
  pose: MutableRefObject<WalkPose>;
  currentRoomId: string | null;
  roomHighlight: (roomId: string) => "none" | "question" | "permission";
  participantAlert: (id: string) => "none" | "question" | "permission";
}) {
  const { rooms, desks } = office.floorplan;
  const marker = useRef<SVGGElement>(null);

  const ext = useMemo(() => planExtent(rooms), [rooms]);
  const walls = useMemo(() => rooms.flatMap((room) => wallSegments(room)), [rooms]);
  const current = rooms.find((r) => r.id === currentRoomId) ?? null;

  // The marker follows the pose ref directly, outside React's render cycle.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const p = pose.current;
      marker.current?.setAttribute(
        "transform",
        `translate(${p.x.toFixed(2)} ${p.z.toFixed(2)}) rotate(${((-p.yaw * 180) / Math.PI).toFixed(1)})`,
      );
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [pose]);

  return (
    <div className="panel" id="minimap">
      <div className="panel-head">
        <span>Map</span>
        <span>{current ? current.name : "Outside"}</span>
      </div>
      <svg
        viewBox={`${ext.minX - MARGIN} ${ext.minZ - MARGIN} ${ext.maxX - ext.minX + MARGIN * 2} ${
          ext.maxZ - ext.minZ + MARGIN * 2
        }`}
        role="img"
        aria-label="Floor plan with your position"
      >
        {rooms.map((room) => {
          const halt = roomHighlight(room.id);
          return (
            <g key={room.id}>
              <rect
                x={room.bounds.x}
                y={room.bounds.z}
                width={room.bounds.w}
                height={room.bounds.d}
                fill={ROOM_TINT[room.id] ?? "#d4d0c8"}
                opacity={room.id === currentRoomId ? 0.5 : 0.24}
              />
              {halt !== "none" && (
                <rect
                  x={room.bounds.x + 0.5}
                  y={room.bounds.z + 0.5}
                  width={room.bounds.w - 1}
                  height={room.bounds.d - 1}
                  fill={HALT_COLOUR[halt]}
                  fillOpacity={0.22}
                  stroke={HALT_COLOUR[halt]}
                  strokeWidth={0.22}
                />
              )}
              <text
                x={room.bounds.x + room.bounds.w / 2}
                y={room.bounds.z + 1.55}
                textAnchor="middle"
                className="map-room"
              >
                {room.name}
              </text>
            </g>
          );
        })}

        {walls.map((w) => (
          <rect
            key={w.id}
            x={w.cx - w.lx / 2}
            y={w.cz - w.lz / 2}
            width={w.lx}
            height={w.lz}
            fill="#f1ede5"
            opacity={0.85}
          />
        ))}

        {office.participants.map((p) => {
          const desk = desks.find((d) => d.id === p.deskId);
          if (!desk) return null;
          const seat = seatPosition(desk);
          const alert = participantAlert(p.id);
          return (
            <g key={p.id} transform={`translate(${seat.x} ${seat.z})`}>
              {alert !== "none" && (
                <circle r={0.95} fill="none" stroke={HALT_COLOUR[alert]} strokeWidth={0.22} />
              )}
              {p.kind === "agent" ? (
                <rect
                  x={-0.42}
                  y={-0.42}
                  width={0.84}
                  height={0.84}
                  transform="rotate(45)"
                  fill={p.appearance.color}
                  stroke="#16181d"
                  strokeWidth={0.1}
                />
              ) : (
                <circle r={0.5} fill={p.appearance.color} stroke="#16181d" strokeWidth={0.1} />
              )}
              <title>{`${p.displayName} (${p.kind === "agent" ? "AI agent" : "human"})`}</title>
            </g>
          );
        })}

        <g ref={marker}>
          <path d="M0 -1.9 L4.2 -7.5 L-4.2 -7.5 Z" fill="#ffffff" opacity={0.1} />
          <circle r={0.72} fill="#ffffff" stroke="#16181d" strokeWidth={0.14} />
          <path d="M0 -1.5 L0.62 -0.5 L-0.62 -0.5 Z" fill="#ffffff" />
        </g>
      </svg>
      <div className="map-legend">
        <span>
          <i className="mark human" /> Human
        </span>
        <span>
          <i className="mark agent" /> AI agent
        </span>
        <span>
          <i className="mark you" /> You
        </span>
      </div>
    </div>
  );
}
