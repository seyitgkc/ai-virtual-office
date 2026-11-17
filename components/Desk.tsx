"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { CanvasTexture, SRGBColorSpace, type MeshBasicMaterial, type MeshStandardMaterial } from "three";
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

/** A task lying on a desk, as a folder in the colour of its state. */
export interface DeskFolder {
  id: string;
  /** How it is named, such as T-12. */
  label: string;
  /** Its title and state, for whoever points at it. */
  hint: string;
  colour: string;
  urgent: boolean;
}

const LAMP_OFF = "#3a3f47";
/** As many folders lie side by side. Any beyond that are stacked on the last. */
const FOLDERS_ACROSS = 5;

/**
 * A lamp on the corner of the desk in the colour of what its occupant is
 * doing, so the state of every desk reads from above. It glows steadily
 * while work waits and beats while an agent is taking its step.
 */
function Lamp({ tone, active }: { tone: DeskTone; active: boolean }) {
  const glass = useRef<MeshStandardMaterial>(null);
  const pool = useRef<MeshBasicMaterial>(null);
  const colour = tone === "idle" ? LAMP_OFF : TONE_COLOUR[tone];
  useFrame((state) => {
    const beat = Math.sin(state.clock.elapsedTime * 6);
    if (glass.current) glass.current.emissiveIntensity = tone === "idle" ? 0 : active ? 1.6 + beat * 0.9 : 0.8;
    if (pool.current) pool.current.opacity = active ? 0.42 + beat * 0.2 : 0.2;
  });
  return (
    <>
      <group position={[0.58, 0.75, -0.68]}>
        <mesh position={[0, 0.04, 0]}>
          <cylinderGeometry args={[0.09, 0.11, 0.08, 16]} />
          <meshStandardMaterial color="#45494f" roughness={0.6} />
        </mesh>
        <mesh position={[0, 0.2, 0]}>
          <sphereGeometry args={[0.12, 18, 18]} />
          <meshStandardMaterial ref={glass} color={colour} emissive={colour} emissiveIntensity={0} roughness={0.35} />
        </mesh>
      </group>
      {/* the lamp's light on the floor, wide enough to read from across the office */}
      {tone !== "idle" && (
        <mesh position={[0, 0.035, -0.12]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[1.28, 40]} />
          <meshBasicMaterial ref={pool} color={colour} transparent opacity={0.2} depthWrite={false} toneMapped={false} />
        </mesh>
      )}
    </>
  );
}

/** The open tasks an occupant holds, laid out along the front of the desk. */
function Folders({ folders, onOpen }: { folders: DeskFolder[]; onOpen: (taskId: string) => void }) {
  return (
    <>
      {folders.map((folder, i) => {
        const column = Math.min(i, FOLDERS_ACROSS - 1);
        const layer = Math.max(0, i - (FOLDERS_ACROSS - 1));
        return (
          <group
            key={folder.id}
            position={[-0.56 + column * 0.225, 0.765 + layer * 0.03, -0.3]}
            rotation={[0, ((i * 37) % 9) * 0.02 - 0.08, 0]}
            onClick={(e) => {
              e.stopPropagation();
              if (e.delta <= 4) onOpen(folder.id);
            }}
            onPointerOver={(e) => {
              e.stopPropagation();
              document.body.style.cursor = "pointer";
            }}
            onPointerOut={() => {
              document.body.style.cursor = "auto";
            }}
          >
            <mesh castShadow>
              <boxGeometry args={[0.19, 0.026, 0.27]} />
              <meshStandardMaterial color={folder.colour} emissive={folder.colour} emissiveIntensity={0.28} roughness={0.55} />
            </mesh>
            {/* an urgent task carries a red band */}
            {folder.urgent && (
              <mesh position={[0, 0.015, 0.09]}>
                <boxGeometry args={[0.192, 0.006, 0.05]} />
                <meshBasicMaterial color="#e0614f" toneMapped={false} />
              </mesh>
            )}
          </group>
        );
      })}
    </>
  );
}

export function DeskMesh({
  desk,
  screen,
  active = false,
  folders = [],
  onOpenTask,
}: {
  desk: DeskModel;
  screen?: DeskScreen | null;
  /** True while the agent at this desk is taking a step. */
  active?: boolean;
  /** The open tasks its occupant holds. */
  folders?: DeskFolder[];
  onOpenTask?: (taskId: string) => void;
}) {
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
      {screen && <Lamp tone={screen.state.tone} active={active} />}
      {folders.length > 0 && <Folders folders={folders} onOpen={(id) => onOpenTask?.(id)} />}
    </group>
  );
}
