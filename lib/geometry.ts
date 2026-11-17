/**
 * Floorplan to 3D geometry.
 *
 * Rooms are axis-aligned rectangles. Each of the four walls is split into
 * segments around its door openings. Walls are inset slightly so neighbouring
 * rooms read as separate volumes instead of z-fighting on a shared plane.
 *
 * Convention: south = low z, north = high z, west = low x, east = high x.
 */
import type { Desk, Door, Floorplan, Room, Wall } from "./model";

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
  /** Width of the opening along its wall. */
  width: number;
  /** True when the wall runs along x (a north or south wall). */
  alongX: boolean;
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
    return {
      id: door.id,
      cx,
      cz,
      exterior: door.toRoomId === null,
      width: door.width,
      alongX: isHorizontal(door.wall),
    };
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

// ---------------------------------------------------------------------------
// Walking the plan
// ---------------------------------------------------------------------------

/** Footprint of something a walker cannot pass through. */
export interface Obstacle {
  cx: number;
  cz: number;
  lx: number;
  lz: number;
}

/** Where a walker stands and which way they face. Yaw 0 looks toward low z. */
export interface WalkPose {
  x: number;
  z: number;
  yaw: number;
}

/** Distance from desk origin to the occupant's seat, in the desk's own frame. */
export const SEAT_OFFSET = 0.32;

export function seatPosition(desk: Desk): { x: number; z: number } {
  return {
    x: desk.position.x + SEAT_OFFSET * Math.sin(desk.facing),
    z: desk.position.z + SEAT_OFFSET * Math.cos(desk.facing),
  };
}

/**
 * Every wall segment, desk and seated occupant in the plan. The doorways of
 * the rooms in `closed` are shut as well, for a walker who may not enter them.
 */
export function obstacles(floorplan: Floorplan, closed: ReadonlySet<string> = new Set()): Obstacle[] {
  const out: Obstacle[] = [];
  for (const room of floorplan.rooms) {
    if (!closed.has(room.id)) continue;
    for (const door of room.doors) {
      const { cx, cz } = doorCentre(room, door);
      const alongX = isHorizontal(door.wall);
      out.push({ cx, cz, lx: alongX ? door.width : WALL_THICK, lz: alongX ? WALL_THICK : door.width });
    }
  }
  for (const room of floorplan.rooms) {
    for (const s of wallSegments(room)) {
      out.push({ cx: s.cx, cz: s.cz, lx: s.lx, lz: s.lz });
    }
  }
  for (const desk of floorplan.desks) {
    const sin = Math.sin(desk.facing);
    const cos = Math.cos(desk.facing);
    // The desk top is 1.5 by 0.74 and sits 0.46 in front of the desk origin.
    out.push({
      cx: desk.position.x - 0.46 * sin,
      cz: desk.position.z - 0.46 * cos,
      lx: Math.abs(1.5 * cos) + Math.abs(0.74 * sin),
      lz: Math.abs(1.5 * sin) + Math.abs(0.74 * cos),
    });
    if (desk.occupantId) {
      const seat = seatPosition(desk);
      out.push({ cx: seat.x, cz: seat.z, lx: 0.5, lz: 0.5 });
    }
  }
  return out;
}

const blocked = (x: number, z: number, radius: number, all: Obstacle[]): boolean =>
  all.some(
    (o) =>
      Math.abs(x - o.cx) < o.lx / 2 + radius && Math.abs(z - o.cz) < o.lz / 2 + radius,
  );

/**
 * Move a walker by (dx, dz), one axis at a time, so that hitting a wall at an
 * angle slides along it instead of stopping dead.
 */
export function stepWalker(
  from: { x: number; z: number },
  dx: number,
  dz: number,
  all: Obstacle[],
  radius: number,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
): { x: number; z: number } {
  let { x, z } = from;
  const nx = Math.min(Math.max(x + dx, bounds.minX), bounds.maxX);
  if (!blocked(nx, z, radius, all)) x = nx;
  const nz = Math.min(Math.max(z + dz, bounds.minZ), bounds.maxZ);
  if (!blocked(x, nz, radius, all)) z = nz;
  return { x, z };
}

/** How wide a walker is, and how far past the outer walls they may go. */
export const BODY_RADIUS = 0.3;
export const OUTSIDE_MARGIN = 2.6;

/** The rectangle a walker is kept inside: the plan and a strip around it. */
export function walkBounds(rooms: Room[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const ext = planExtent(rooms);
  return {
    minX: ext.minX - OUTSIDE_MARGIN,
    maxX: ext.maxX + OUTSIDE_MARGIN,
    minZ: ext.minZ - OUTSIDE_MARGIN,
    maxZ: ext.maxZ + OUTSIDE_MARGIN,
  };
}

/** How near a picked point must be to someone's seat to mean "go to this person". */
const PICKS_PERSON = 1.1;
/** How far from a seat a walker stands when they go to its occupant. */
const STANDS_OFF = 1.7;

export type Landing = { ok: true; pose: WalkPose } | { ok: false; why: "shut" | "nowhere" };

/**
 * Where a walker ends up when they pick a point on the map, or why they
 * cannot go there. A room that is shut to them refuses. A point inside a
 * wall or a desk gives the nearest free spot in the same room. A point on
 * someone's seat gives a spot a step back from them, on the side the walker
 * is coming from when that side is free, turned to face them.
 */
export function landingSpot(
  floorplan: Floorplan,
  closed: ReadonlySet<string>,
  from: WalkPose,
  picked: { x: number; z: number },
): Landing {
  const bounds = walkBounds(floorplan.rooms);
  const inBounds = (x: number, z: number): boolean => x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
  const room = roomAt(floorplan.rooms, picked.x, picked.z);
  if (room && closed.has(room.id)) return { ok: false, why: "shut" };
  const all = obstacles(floorplan, closed);
  const roomId = room?.id ?? null;
  const free = (x: number, z: number): boolean =>
    inBounds(x, z) && (roomAt(floorplan.rooms, x, z)?.id ?? null) === roomId && !blocked(x, z, BODY_RADIUS, all);

  // The seat that was picked, if one was: the nearest within reach of the point.
  let seat: { x: number; z: number } | null = null;
  let nearest = PICKS_PERSON;
  for (const desk of floorplan.desks) {
    if (!desk.occupantId || desk.roomId !== roomId) continue;
    const s = seatPosition(desk);
    const d = Math.hypot(s.x - picked.x, s.z - picked.z);
    if (d < nearest) {
      nearest = d;
      seat = s;
    }
  }
  if (seat) {
    const towards = Math.atan2(from.z - seat.z, from.x - seat.x);
    for (let turn = 0; turn <= 6; turn++) {
      for (const side of turn === 0 ? [0] : [1, -1]) {
        const angle = towards + (side * turn * Math.PI) / 6;
        const x = seat.x + Math.cos(angle) * STANDS_OFF;
        const z = seat.z + Math.sin(angle) * STANDS_OFF;
        // Forward is (-sin yaw, -cos yaw), so this yaw looks from the spot to the seat.
        if (free(x, z)) return { ok: true, pose: { x, z, yaw: Math.atan2(x - seat.x, z - seat.z) } };
      }
    }
  }

  if (free(picked.x, picked.z)) return { ok: true, pose: { x: picked.x, z: picked.z, yaw: from.yaw } };
  for (let ring = 1; ring <= 6; ring++) {
    for (let step = 0; step < 16; step++) {
      const angle = (step * Math.PI) / 8;
      const x = picked.x + Math.cos(angle) * ring * 0.3;
      const z = picked.z + Math.sin(angle) * ring * 0.3;
      if (free(x, z)) return { ok: true, pose: { x, z, yaw: from.yaw } };
    }
  }
  return { ok: false, why: "nowhere" };
}

/** The room containing a point, or null when the point is outside the plan. */
export function roomAt(rooms: Room[], x: number, z: number): Room | null {
  return (
    rooms.find(
      (r) =>
        x >= r.bounds.x &&
        x < r.bounds.x + r.bounds.w &&
        z >= r.bounds.z &&
        z < r.bounds.z + r.bounds.d,
    ) ?? null
  );
}

/**
 * Where a visitor starts: just outside the first exterior door, facing in.
 * Falls back to the middle of the first room when the plan has no way in.
 */
export function entryPose(rooms: Room[]): WalkPose {
  for (const room of rooms) {
    const door = room.doors.find((d) => d.toRoomId === null);
    if (!door) continue;
    const { cx, cz } = doorCentre(room, door);
    const out = 2.2;
    switch (door.wall) {
      case "south":
        return { x: cx, z: cz - out, yaw: Math.PI };
      case "north":
        return { x: cx, z: cz + out, yaw: 0 };
      case "east":
        return { x: cx + out, z: cz, yaw: Math.PI / 2 };
      case "west":
        return { x: cx - out, z: cz, yaw: -Math.PI / 2 };
    }
  }
  const first = rooms[0];
  return first ? { ...centreOf(first), yaw: 0 } : { x: 0, z: 0, yaw: 0 };
}

const centreOf = (room: Room): { x: number; z: number } => ({
  x: room.bounds.x + room.bounds.w / 2,
  z: room.bounds.z + room.bounds.d / 2,
});

/**
 * A place for one more desk in a room: clear of the walls, the doorways and
 * the desks already there. Null when the room is full.
 */
export function freeDeskSpot(floorplan: Floorplan, roomId: string): { x: number; z: number } | null {
  const room = floorplan.rooms.find((r) => r.id === roomId);
  if (!room) return null;
  const taken = floorplan.desks.filter((d) => d.roomId === roomId).map((d) => d.position);
  const doors = room.doors.map((door) => doorCentre(room, door));
  const margin = 1.8;
  const b = room.bounds;

  for (let z = b.z + margin; z <= b.z + b.d - margin; z += 0.5) {
    for (let x = b.x + margin; x <= b.x + b.w - margin; x += 0.5) {
      const clearOfDesks = taken.every((t) => Math.hypot(t.x - x, t.z - z) >= 3);
      const clearOfDoors = doors.every((d) => Math.hypot(d.cx - x, d.cz - z) >= 2.2);
      if (clearOfDesks && clearOfDoors) return { x, z };
    }
  }
  return null;
}
