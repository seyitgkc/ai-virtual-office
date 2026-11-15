"use client";

import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Fog, PerspectiveCamera } from "three";
import type { Floorplan } from "../lib/model";
import {
  obstacles,
  planExtent,
  roomAt,
  stepWalker,
  type WalkPose,
} from "../lib/geometry";

const EYE_HEIGHT = 1.5;
const BODY_RADIUS = 0.3;
const WALK_SPEED = 4.8;
const RUN_SPEED = 8.4;
/** Head movement while walking: metres travelled per step, and how far the view rises and sways. */
const STRIDE = 1.5;
const BOB_HEIGHT = 0.05;
const BOB_SWAY = 0.028;
const BOB_ROLL = 0.006;
const TURN_SPEED = 1.9;
const LOOK_SENSITIVITY = 0.0042;
const MAX_PITCH = 1.15;
const WALK_FOV = 68;
/** How close, and how squarely faced, someone must be to be talked to. */
const REACH = 3.2;
const FACING_COS = Math.cos(0.5);
const INTERACT_KEY = "KeyF";
/** How far past the outer walls a walker may go. */
const OUTSIDE_MARGIN = 2.6;

const CONTROL_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyQ",
  "KeyE",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ShiftLeft",
  "ShiftRight",
]);

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

/**
 * First-person movement through the plan. W A S D or the arrow keys move,
 * dragging on the scene looks around, Shift moves faster. Walls, desks and
 * seated people block the way; doorways do not.
 *
 * The pose lives in a ref owned by the page, so the minimap can follow it
 * without a React render per frame and the walker returns to the same spot
 * after a visit to the overview.
 */
export function WalkControls({
  floorplan,
  pose,
  onRoomChange,
  seats,
  closedRooms,
  onFace,
  onInteract,
}: {
  floorplan: Floorplan;
  /** Rooms this person may not enter. Their doorways are shut to the walker. */
  closedRooms: ReadonlySet<string>;
  pose: RefObject<WalkPose>;
  onRoomChange: (roomId: string | null) => void;
  /** Everyone seated in the office, other than the walker. */
  seats: { id: string; x: number; z: number; roomId: string }[];
  /** Called when the person the walker is close to and facing changes. */
  onFace: (id: string | null) => void;
  /** Called when the walker presses F while facing someone. */
  onInteract: (id: string) => void;
}) {
  const { camera, gl, scene } = useThree();
  const keys = useRef(new Set<string>());
  const pitch = useRef(0);
  const lastRoom = useRef<string | null | undefined>(undefined);
  const facing = useRef<string | null>(null);
  const interact = useRef(onInteract);
  interact.current = onInteract;

  // Nobody is faced once the walk ends.
  useEffect(() => () => onFace(null), [onFace]);

  const all = useMemo(() => obstacles(floorplan, closedRooms), [floorplan, closedRooms]);
  // How far the walker has gone, which drives the rise and fall of the view,
  // and how much of that movement is showing: it eases in and out of a stride.
  const travelled = useRef(0);
  const bob = useRef(0);
  const stillness = useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const bounds = useMemo(() => {
    const ext = planExtent(floorplan.rooms);
    return {
      minX: ext.minX - OUTSIDE_MARGIN,
      maxX: ext.maxX + OUTSIDE_MARGIN,
      minZ: ext.minZ - OUTSIDE_MARGIN,
      maxZ: ext.maxZ + OUTSIDE_MARGIN,
    };
  }, [floorplan]);

  // Wide lens at eye level while walking; the overview lens comes back on exit.
  useEffect(() => {
    if (!(camera instanceof PerspectiveCamera)) return;
    const before = { fov: camera.fov, near: camera.near };
    camera.fov = WALK_FOV;
    camera.near = 0.05;
    camera.rotation.order = "YXZ";
    camera.updateProjectionMatrix();
    if (scene.fog instanceof Fog) {
      scene.fog.near = 24;
      scene.fog.far = 72;
    }
    return () => {
      camera.fov = before.fov;
      camera.near = before.near;
      camera.rotation.order = "XYZ";
      camera.updateProjectionMatrix();
    };
  }, [camera, scene]);

  useEffect(() => {
    const held = keys.current;
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === INTERACT_KEY) {
        if (facing.current && !e.repeat) {
          e.preventDefault();
          held.clear();
          interact.current(facing.current);
        }
        return;
      }
      if (!CONTROL_KEYS.has(e.code)) return;
      held.add(e.code);
      e.preventDefault();
    };
    const up = (e: KeyboardEvent) => held.delete(e.code);
    const clear = () => held.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
      held.clear();
    };
  }, []);

  useEffect(() => {
    const el = gl.domElement;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      // Give the keyboard back to the scene after typing in a panel.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      el.style.cursor = "grabbing";
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      pose.current.yaw -= (e.clientX - lastX) * LOOK_SENSITIVITY;
      pitch.current = Math.min(
        MAX_PITCH,
        Math.max(-MAX_PITCH, pitch.current - (e.clientY - lastY) * LOOK_SENSITIVITY),
      );
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const up = () => {
      dragging = false;
      el.style.cursor = "grab";
    };

    el.style.cursor = "grab";
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      el.style.cursor = "";
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [gl, pose]);

  useFrame((_, delta) => {
    // Capped so a slow frame cannot carry the walker through a wall.
    const dt = Math.min(delta, 0.1);
    const held = keys.current;
    const p = pose.current;

    const turn =
      (held.has("ArrowLeft") || held.has("KeyQ") ? 1 : 0) -
      (held.has("ArrowRight") || held.has("KeyE") ? 1 : 0);
    p.yaw += turn * TURN_SPEED * dt;

    const forward =
      (held.has("KeyW") || held.has("ArrowUp") ? 1 : 0) -
      (held.has("KeyS") || held.has("ArrowDown") ? 1 : 0);
    const strafe = (held.has("KeyD") ? 1 : 0) - (held.has("KeyA") ? 1 : 0);

    let moved = 0;
    if (forward !== 0 || strafe !== 0) {
      const running = held.has("ShiftLeft") || held.has("ShiftRight");
      const distance = ((running ? RUN_SPEED : WALK_SPEED) * dt) / Math.hypot(forward, strafe);
      const sin = Math.sin(p.yaw);
      const cos = Math.cos(p.yaw);
      // Forward is (-sin, -cos) and right is (cos, -sin) on the floor plane.
      const dx = (-sin * forward + cos * strafe) * distance;
      const dz = (-cos * forward - sin * strafe) * distance;
      const next = stepWalker(p, dx, dz, all, BODY_RADIUS, bounds);
      moved = Math.hypot(next.x - p.x, next.z - p.z);
      p.x = next.x;
      p.z = next.z;
    }

    // The view rises and falls twice per stride and sways once, as a head
    // does. It fades out when the walker stops or is held by a wall.
    travelled.current += moved;
    const target = moved > 0.0005 && !stillness ? 1 : 0;
    bob.current += (target - bob.current) * Math.min(1, dt * 9);
    const phase = (travelled.current / STRIDE) * Math.PI * 2;
    const lift = Math.sin(phase * 2) * BOB_HEIGHT * bob.current;
    const sway = Math.sin(phase) * BOB_SWAY * bob.current;
    camera.position.set(p.x + Math.cos(p.yaw) * sway, EYE_HEIGHT + lift, p.z - Math.sin(p.yaw) * sway);
    camera.rotation.set(pitch.current, p.yaw, Math.sin(phase) * BOB_ROLL * bob.current);

    const room = roomAt(floorplan.rooms, p.x, p.z)?.id ?? null;
    if (room !== lastRoom.current) {
      lastRoom.current = room;
      onRoomChange(room);
    }

    // The nearest person in this room who is within reach and in front.
    let faced: string | null = null;
    let nearest = REACH;
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    for (const seat of seats) {
      if (seat.roomId !== room) continue;
      const dx = seat.x - p.x;
      const dz = seat.z - p.z;
      const distance = Math.hypot(dx, dz);
      if (distance >= nearest || distance < 0.01) continue;
      if ((dx * fx + dz * fz) / distance < FACING_COS) continue;
      nearest = distance;
      faced = seat.id;
    }
    if (faced !== facing.current) {
      facing.current = faced;
      onFace(faced);
    }
  });

  return null;
}
