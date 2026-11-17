"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { Office } from "../lib/model";
import {
  landingSpot,
  PICKS_PERSON,
  PICKS_PERSON_BY_TOUCH,
  planExtent,
  seatPosition,
  wallSegments,
  type WalkPose,
} from "../lib/geometry";
import { kindName } from "./Panels";
import { ROOM_TINT } from "./RoomMesh";

const MARGIN = 2.8;
const HALT_COLOUR = { question: "#e0a23f", permission: "#e0614f" } as const;

/**
 * Top-down plan with the walker's position and heading. Drawn in world units
 * (metres), oriented like the overview: low z at the top. Picking a place on
 * it puts the walker there, and picking a person puts the walker in front of
 * them. Pointing at a person shows their name.
 */
export function Minimap({
  office,
  pose,
  currentRoomId,
  roomHighlight,
  participantAlert,
  closedRooms,
  viewerId,
  onLeave,
}: {
  office: Office;
  pose: RefObject<WalkPose>;
  currentRoomId: string | null;
  roomHighlight: (roomId: string) => "none" | "question" | "permission";
  participantAlert: (id: string) => "none" | "question" | "permission";
  /** Rooms the walker may not enter. They cannot be picked. */
  closedRooms: ReadonlySet<string>;
  viewerId: string;
  /** Ends the walk. On a phone the map fills the view, so the way back is offered here too. */
  onLeave: () => void;
}) {
  const { rooms, desks } = office.floorplan;
  const marker = useRef<SVGGElement>(null);
  const plan = useRef<SVGSVGElement>(null);
  const [pointedAt, setPointedAt] = useState<string | null>(null);
  // Why the last pick went nowhere. It clears itself.
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    if (!said) return;
    const timer = window.setTimeout(() => setSaid(null), 2600);
    return () => window.clearTimeout(timer);
  }, [said]);

  // A pick is taken from where the pointer went down. A browser moves the
  // click of a finger towards whatever it thinks was meant, which on a map
  // this small is a metre or more.
  const pressed = useRef<{ id: number; x: number; y: number } | null>(null);
  const press = (e: PointerEvent<SVGSVGElement>): void => {
    pressed.current = e.isPrimary && e.button === 0 ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
  };
  const pick = (e: PointerEvent<SVGSVGElement>): void => {
    const from = pressed.current;
    pressed.current = null;
    // A finger that slid was not a tap.
    if (!from || from.id !== e.pointerId || Math.hypot(e.clientX - from.x, e.clientY - from.y) > 10) return;
    const svg = plan.current;
    const toPlan = svg?.getScreenCTM()?.inverse();
    if (!svg || !toPlan) return;
    const at = new DOMPoint(from.x, from.y).matrixTransform(toPlan);
    const landing = landingSpot(
      office.floorplan,
      closedRooms,
      pose.current,
      { x: at.x, z: at.y },
      e.pointerType === "touch" ? PICKS_PERSON_BY_TOUCH : PICKS_PERSON,
    );
    if (landing.ok) {
      // The walk reads this pose on its next frame, so the view moves at once.
      Object.assign(pose.current, landing.pose);
      setSaid(null);
    } else {
      setSaid(landing.why === "shut" ? "You may not enter that room." : "There is nowhere to stand there.");
    }
  };

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
        <button type="button" className="btn map-leave" onClick={onLeave}>
          Back to overview
        </button>
        <span>{current ? current.name : "Outside"}</span>
      </div>
      <svg
        ref={plan}
        viewBox={`${ext.minX - MARGIN} ${ext.minZ - MARGIN} ${ext.maxX - ext.minX + MARGIN * 2} ${
          ext.maxZ - ext.minZ + MARGIN * 2
        }`}
        role="img"
        aria-label="Floor plan with your position. Pick a place to go there."
        onPointerDown={press}
        onPointerUp={pick}
        onPointerCancel={() => (pressed.current = null)}
      >
        {rooms.map((room) => {
          const halt = roomHighlight(room.id);
          return (
            <g key={room.id} className={closedRooms.has(room.id) ? "map-shut" : undefined}>
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
            <g
              key={p.id}
              className="map-person"
              transform={`translate(${seat.x} ${seat.z})`}
              aria-label={`${p.displayName} (${kindName(p).toLowerCase()})`}
              onPointerEnter={() => setPointedAt(p.id)}
              onPointerLeave={() => setPointedAt((now) => (now === p.id ? null : now))}
            >
              {/* The mark is a few pixels across, so the area that answers to the pointer is wider. */}
              <circle r={1.25} fill="transparent" />
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
            </g>
          );
        })}

        {/* The walker's mark and its cone of view do not take the pointer, so whoever is under them can still be picked. */}
        <g ref={marker} pointerEvents="none">
          <path d="M0 -1.9 L4.2 -7.5 L-4.2 -7.5 Z" fill="#ffffff" opacity={0.1} />
          <circle r={0.72} fill="#ffffff" stroke="#16181d" strokeWidth={0.14} />
          <path d="M0 -1.5 L0.62 -0.5 L-0.62 -0.5 Z" fill="#ffffff" />
        </g>

        {/* The name of whoever the pointer is on, drawn last so that nothing covers it. */}
        {office.participants.map((p) => {
          if (p.id !== pointedAt) return null;
          const desk = desks.find((d) => d.id === p.deskId);
          if (!desk) return null;
          const seat = seatPosition(desk);
          const width = ext.maxX - ext.minX;
          const along = (seat.x - ext.minX) / (width || 1);
          return (
            <text
              key={p.id}
              className="map-name"
              x={seat.x}
              y={seat.z - ext.minZ < 2 ? seat.z + 2.6 : seat.z - 1.3}
              textAnchor={along < 0.25 ? "start" : along > 0.75 ? "end" : "middle"}
            >
              {p.displayName}
              {p.id === viewerId ? " (You)" : ""}
            </text>
          );
        })}
      </svg>
      <div className="map-legend">
        <span>
          <i className="mark human" /> Human
        </span>
        <span>
          <i className="mark agent" /> Agent
        </span>
        <span>
          <i className="mark you" /> You
        </span>
        {said && (
          <span className="map-said" role="status">
            {said}
          </span>
        )}
      </div>
    </div>
  );
}
