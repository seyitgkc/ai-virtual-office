/**
 * Floorplan to 3D geometry.
 *
 * Rooms are axis-aligned rectangles. Each of the four walls is split into
 * segments around its door openings. Walls are inset slightly so neighbouring
 * rooms read as separate volumes instead of z-fighting on a shared plane.
 *
 * Convention: south = low z, north = high z, west = low x, east = high x.
 */
import type { Door, Room, Wall } from "./model";

/**
 * Deliberately low. Full-height walls occlude the rooms behind them from any
 * useful camera angle, so the office is drawn as a cutaway architectural
 * model: the boundary is legible, the interior stays visible.
 */
export const WALL_HEIGHT = 1.15;
export const WALL_THICK = 0.16;
/** Pulls each room's walls inward so a shared boundary shows a visible seam. */
export const INSET = 0.1;

/** A box, by centre and full extents. Feeds straight into <boxGeometry>. */
export interface WallSegment {
  id: string;
  cx: number;
  cz: number;
  lx: number;
  lz: number;
}

export interface DoorMarker {
  id: string;
  cx: number;
  cz: number;
  /** True when it leads outside rather than to another room. */
  exterior: boolean;
}

interface Gap {
  from: number;
  to: number;
}

/** Carve gaps out of a 1-D span, returning what's left. */
function subtractGaps(from: number, to: number, gaps: Gap[]): Array<[number, number]> {
  const sorted = [...gaps].sort((a, b) => a.from - b.from);
  const out: Array<[number, number]> = [];
  let cursor = from;
  for (const gap of sorted) {
    const start = Math.max(gap.from, from);
    const end = Math.min(gap.to, to);
    if (end <= cursor) continue;
    if (start > cursor) out.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < to) out.push([cursor, to]);
  return out.filter(([a, b]) => b - a > 0.02);
}

const isHorizontal = (wall: Wall): boolean => wall === "north" || wall === "south";

/** Centre point of a door along its wall, in world coordinates. */
export function doorCentre(room: Room, door: Door): { cx: number; cz: number } {
  const b = room.bounds;
  if (isHorizontal(door.wall)) {
    return {
      cx: b.x + door.along * b.w,
      cz: door.wall === "north" ? b.z + b.d - INSET : b.z + INSET,
    };
  }
  return {
    cx: door.wall === "east" ? b.x + b.w - INSET : b.x + INSET,
    cz: b.z + door.along * b.d,
  };
}

export function wallSegments(room: Room): WallSegment[] {
  const b = room.bounds;
  const x0 = b.x + INSET;
  const x1 = b.x + b.w - INSET;
  const z0 = b.z + INSET;
  const z1 = b.z + b.d - INSET;
  const out: WallSegment[] = [];

  const walls: Wall[] = ["north", "south", "east", "west"];
  for (const wall of walls) {
    const doors = room.doors.filter((d) => d.wall === wall);

    if (isHorizontal(wall)) {
      const cz = wall === "north" ? z1 : z0;
      const gaps = doors.map((d) => {
        const c = b.x + d.along * b.w;
        return { from: c - d.width / 2, to: c + d.width / 2 };
      });
      subtractGaps(x0, x1, gaps).forEach(([a, c], i) => {
        out.push({
          id: `${room.id}-${wall}-${i}`,
          cx: (a + c) / 2,
          cz,
          lx: c - a,
          lz: WALL_THICK,
        });
      });
    } else {
      const cx = wall === "east" ? x1 : x0;
      const gaps = doors.map((d) => {
        const c = b.z + d.along * b.d;
        return { from: c - d.width / 2, to: c + d.width / 2 };
      });
      subtractGaps(z0, z1, gaps).forEach(([a, c], i) => {
        out.push({
          id: `${room.id}-${wall}-${i}`,
          cx,
          cz: (a + c) / 2,
          lx: WALL_THICK,
          lz: c - a,
        });
      });
    }
  }
  return out;
}

export function doorMarkers(room: Room): DoorMarker[] {
  return room.doors.map((door) => {
    const { cx, cz } = doorCentre(room, door);
    return { id: door.id, cx, cz, exterior: door.toRoomId === null };
  });
}

/** Centre of a room, for labels and camera framing. */
export function roomCentre(room: Room): { cx: number; cz: number } {
  return {
    cx: room.bounds.x + room.bounds.w / 2,
    cz: room.bounds.z + room.bounds.d / 2,
  };
}

/** Bounding box of the whole plan, for the initial camera position. */
export function planExtent(rooms: Room[]): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  return rooms.reduce(
    (acc, r) => ({
      minX: Math.min(acc.minX, r.bounds.x),
      maxX: Math.max(acc.maxX, r.bounds.x + r.bounds.w),
      minZ: Math.min(acc.minZ, r.bounds.z),
      maxZ: Math.max(acc.maxZ, r.bounds.z + r.bounds.d),
    }),
    { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
  );
}
