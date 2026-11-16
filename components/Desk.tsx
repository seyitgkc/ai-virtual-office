"use client";

import { useEffect, useMemo } from "react";
import { CanvasTexture, SRGBColorSpace } from "three";
import type { DeskState, DeskTone } from "../lib/agentState";
import type { Desk as DeskModel } from "../lib/model";

/** What a desk's monitor shows: who sits there and what they are doing. */
export interface DeskScreen {
  name: string;
  state: DeskState;
}

const TONE_COLOUR: Record<DeskTone, string> = {
  idle: "#6b7480",
  working: "#6ea9d9",
  question: "#e0a23f",
  permission: "#e0614f",
  review: "#9b8ad9",
};

const WIDTH = 640;
const HEIGHT = 360;

/** Break text into lines that fit a width, up to a number of lines. */
function wrap(context: CanvasRenderingContext2D, text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (context.measureText(next).width <= width) {
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  else if (lines.length === maxLines) lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[\s.,;:]+$/, "")}...`;
  return lines;
}

function draw(screen: DeskScreen): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const c = canvas.getContext("2d");
  if (!c) return canvas;
  const tone = TONE_COLOUR[screen.state.tone];
  const sans = "system-ui, -apple-system, 'Segoe UI', sans-serif";

  c.fillStyle = "#0d1117";
  c.fillRect(0, 0, WIDTH, HEIGHT);
  c.fillStyle = tone;
  c.fillRect(0, 0, WIDTH, 12);

  c.textBaseline = "top";
  c.fillStyle = "#e8e6e1";
  c.font = `600 48px ${sans}`;
  c.fillText(wrap(c, screen.name, WIDTH - 48, 1)[0] ?? "", 24, 30);

  c.fillStyle = tone;
  c.beginPath();
  c.arc(40, 122, 13, 0, Math.PI * 2);
  c.fill();
  c.font = `600 40px ${sans}`;
  c.fillText(screen.state.headline, 66, 98);

  let y = 160;
  if (screen.state.task) {
    c.fillStyle = "#e8e6e1";
    c.font = `30px ${sans}`;
    const more = screen.state.openTasks > 1 ? ` (+${screen.state.openTasks - 1} more)` : "";
    for (const line of wrap(c, `${screen.state.taskLabel ?? screen.state.task.id}${more}: ${screen.state.task.title}`, WIDTH - 48, 2)) {
      c.fillText(line, 24, y);
      y += 38;
    }
    y += 6;
  }
  c.fillStyle = "rgba(232,230,225,0.62)";
  c.font = `26px ${sans}`;
  for (const line of wrap(c, screen.state.detail, WIDTH - 48, Math.max(1, Math.floor((HEIGHT - y - 8) / 33)))) {
    c.fillText(line, 24, y);
    y += 33;
  }
  return canvas;
}

/** The lit face of a monitor, redrawn only when what it shows changes. */
function Screen({ screen }: { screen: DeskScreen }) {
  const { state } = screen;
  const signature = [screen.name, state.tone, state.headline, state.task?.id, state.task?.title, state.detail, state.openTasks].join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const texture = useMemo(() => {
    const made = new CanvasTexture(draw(screen));
    made.colorSpace = SRGBColorSpace;
    made.anisotropy = 4;
    return made;
  }, [signature]);
  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <mesh position={[0, 1.13, -0.638]}>
      <planeGeometry args={[0.82, 0.46]} />
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}

export function DeskMesh({ desk, screen }: { desk: DeskModel; screen?: DeskScreen | null }) {
  const { x, z } = desk.position;
  return (
    <group position={[x, 0, z]} rotation={[0, desk.facing, 0]}>
      {/* top */}
      <mesh position={[0, 0.72, -0.46]} castShadow receiveShadow>
        <boxGeometry args={[1.5, 0.06, 0.74]} />
        <meshStandardMaterial color="#a89a86" roughness={0.6} />
      </mesh>
      {/* legs */}
      {[
        [-0.66, -0.78],
        [0.66, -0.78],
        [-0.66, -0.14],
        [0.66, -0.14],
      ].map(([lx, lz], i) => (
        <mesh key={i} position={[lx, 0.36, lz]} castShadow>
          <boxGeometry args={[0.06, 0.72, 0.06]} />
          <meshStandardMaterial color="#6f6a61" roughness={0.7} />
        </mesh>
      ))}
      {/* monitor */}
      <mesh position={[0, 1.13, -0.66]} castShadow>
        <boxGeometry args={[0.86, 0.5, 0.04]} />
        <meshStandardMaterial color="#2b2f36" roughness={0.4} />
      </mesh>
      {screen && <Screen screen={screen} />}
      <mesh position={[0, 0.81, -0.66]}>
        <boxGeometry args={[0.1, 0.14, 0.08]} />
        <meshStandardMaterial color="#45494f" roughness={0.6} />
      </mesh>
    </group>
  );
}
