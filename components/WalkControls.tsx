"use client";

import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
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
const WALK_SPEED = 3.4;
const RUN_SPEED = 6.5;
const TURN_SPEED = 1.9;
const LOOK_SENSITIVITY = 0.0042;
const MAX_PITCH = 1.15;
const WALK_FOV = 68;
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
}: {
  floorplan: Floorplan;
  pose: MutableRefObject<WalkPose>;
  onRoomChange: (roomId: string | null) => void;
}) {
  const { camera, gl, scene } = useThree();
  const keys = useRef(new Set<string>());
  const pitch = useRef(0);
  const lastRoom = useRef<string | null | undefined>(undefined);

  const all = useMemo(() => obstacles(floorplan), [floorplan]);
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

    if (forward !== 0 || strafe !== 0) {
      const running = held.has("ShiftLeft") || held.has("ShiftRight");
      const distance = ((running ? RUN_SPEED : WALK_SPEED) * dt) / Math.hypot(forward, strafe);
      const sin = Math.sin(p.yaw);
      const cos = Math.cos(p.yaw);
      // Forward is (-sin, -cos) and right is (cos, -sin) on the floor plane.
      const dx = (-sin * forward + cos * strafe) * distance;
      const dz = (-cos * forward - sin * strafe) * distance;
      const next = stepWalker(p, dx, dz, all, BODY_RADIUS, bounds);
      p.x = next.x;
      p.z = next.z;
    }

    camera.position.set(p.x, EYE_HEIGHT, p.z);
    camera.rotation.set(pitch.current, p.yaw, 0);

    const room = roomAt(floorplan.rooms, p.x, p.z)?.id ?? null;
    if (room !== lastRoom.current) {
      lastRoom.current = room;
      onRoomChange(room);
    }
  });

  return null;
}
