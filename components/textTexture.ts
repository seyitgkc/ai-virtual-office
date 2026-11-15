"use client";

import { useEffect, useMemo } from "react";
import { CanvasTexture, SRGBColorSpace } from "three";

/**
 * A texture drawn on a canvas, remade only when `signature` changes and
 * released when it is no longer shown.
 */
export function useCanvasTexture(
  width: number,
  height: number,
  signature: string,
  draw: (context: CanvasRenderingContext2D) => void,
): CanvasTexture {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context) draw(context);
    const made = new CanvasTexture(canvas);
    made.colorSpace = SRGBColorSpace;
    made.anisotropy = 4;
    return made;
  }, [width, height, signature]);
  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

/** The font used for text drawn into the scene. */
export const SCENE_FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
