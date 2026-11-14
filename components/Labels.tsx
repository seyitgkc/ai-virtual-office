"use client";

import { type ReactNode, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3 } from "three";

/** A piece of ordinary HTML pinned to a point in the 3D scene. */
export interface LabelSpec {
  id: string;
  position: [number, number, number];
  node: ReactNode;
  hidden?: boolean;
  /**
   * When set, the label shrinks as the camera moves away, reaching full size
   * at this distance. Left unset, the label keeps a constant size on screen.
   */
  fullSizeAt?: number;
}

export type LabelElements = RefObject<Map<string, HTMLDivElement>>;

/**
 * The DOM half. Renders every label once, absolutely positioned inside a layer
 * that covers the canvas. Positions are written by `LabelProjector`.
 */
export function LabelLayer({ specs, elements }: { specs: LabelSpec[]; elements: LabelElements }) {
  return (
    <div className="labels">
      {specs.map((spec) => (
        <div
          key={spec.id}
          className="label"
          ref={(el) => {
            if (el) elements.current.set(spec.id, el);
            else elements.current.delete(spec.id);
          }}
        >
          {spec.node}
        </div>
      ))}
    </div>
  );
}

const projected = new Vector3();
const world = new Vector3();

/**
 * The 3D half. Lives inside the canvas and, every frame, moves each label to
 * where its anchor point lands on screen. Labels behind the camera are hidden.
 */
export function LabelProjector({ specs, elements }: { specs: LabelSpec[]; elements: LabelElements }) {
  const { camera, size } = useThree();

  useFrame(() => {
    for (const spec of specs) {
      const el = elements.current.get(spec.id);
      if (!el) continue;

      world.set(spec.position[0], spec.position[1], spec.position[2]);
      projected.copy(world).project(camera);
      const visible = !spec.hidden && projected.z > -1 && projected.z < 1;
      if (!visible) {
        el.style.display = "none";
        continue;
      }

      const x = (projected.x * 0.5 + 0.5) * size.width;
      const y = (-projected.y * 0.5 + 0.5) * size.height;
      const scale = spec.fullSizeAt
        ? Math.min(1.6, spec.fullSizeAt / camera.position.distanceTo(world))
        : 1;

      el.style.display = "block";
      el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
    }
  });

  return null;
}
