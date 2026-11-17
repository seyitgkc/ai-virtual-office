"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { BufferGeometry, Line, LineBasicMaterial, Vector3, type Group, type Mesh, type MeshBasicMaterial } from "three";
import type { Message, Office } from "../lib/model";

/**
 * Work made visible as it happens. Each new line in a thread shows at the
 * desk of whoever wrote it, and anything addressed to someone else is seen
 * crossing the office to their desk: a task handed on, a question put to a
 * person, an answer going back, a note between agents. Nothing here is
 * invented: one mark per message the viewer may read, and none for the
 * history already there when the office is opened.
 */

type Spot = { x: number; z: number };

/** One mark in the room. `delay` spaces out marks that arrive together. */
type Mark =
  | { id: string; kind: "ping"; at: Spot; colour: string; big: boolean }
  | { id: string; kind: "flight"; from: Spot; to: Spot; colour: string; big: boolean };
type Effect = Mark & { delay: number };

const COLOUR = {
  work: "#6ea9d9",
  output: "#9fd0f5",
  question: "#e0a23f",
  answer: "#8fd19e",
  halt: "#e0614f",
  note: "#62c4b8",
  approved: "#5fa87a",
  sentBack: "#9b8ad9",
};

const DESK_TOP = 0.86;

/** What one new message looks like in the room, if anything. */
function effectsOf(office: Office, message: Message, seat: (id: string) => Spot | null): Mark[] {
  const from = seat(message.fromId);
  const task = office.tasks.find((t) => t.id === message.taskId);
  const fly = (to: Spot | null, colour: string, big: boolean): Mark[] =>
    from && to && (from.x !== to.x || from.z !== to.z)
      ? [{ id: message.id, kind: "flight", from, to, colour, big }]
      : to
        ? [{ id: message.id, kind: "ping", at: to, colour, big }]
        : from
          ? [{ id: message.id, kind: "ping", at: from, colour, big }]
          : [];
  const here = (colour: string, big = false): Mark[] =>
    from ? [{ id: message.id, kind: "ping", at: from, colour, big }] : [];

  switch (message.kind) {
    case "handoff": {
      const sender = seat(message.fromParticipantId);
      const receiver = seat(message.toParticipantId);
      return sender && receiver
        ? [{ id: message.id, kind: "flight", from: sender, to: receiver, colour: COLOUR.work, big: true }]
        : receiver
          ? [{ id: message.id, kind: "ping", at: receiver, colour: COLOUR.work, big: true }]
          : [];
    }
    case "assignment":
      return fly(seat(message.toParticipantId), COLOUR.work, true);
    case "question":
      return fly(message.audience.to === "participant" ? seat(message.audience.id) : null, COLOUR.question, false);
    case "answer":
      return fly(task?.ownerId ? seat(task.ownerId) : null, COLOUR.answer, false);
    case "note":
      return fly(message.audience.to === "participant" ? seat(message.audience.id) : null, COLOUR.note, false);
    case "escalation":
      return here(COLOUR.halt, true);
    case "decision":
      return here(message.verdict === "approved" ? COLOUR.approved : message.verdict === "rejected" ? COLOUR.halt : COLOUR.sentBack, true);
    case "output":
      return here(COLOUR.output, true);
    case "request":
      return here(COLOUR.work, true);
    default:
      return here(COLOUR.work);
  }
}

const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** A ring that spreads out from a desk and fades. */
function Ping({ effect, onDone }: { effect: Extract<Effect, { kind: "ping" }>; onDone: () => void }) {
  const ring = useRef<Mesh>(null);
  const age = useRef(-effect.delay);
  const over = useRef(false);
  const length = effect.big ? 1.5 : 1.1;
  useFrame((_, delta) => {
    age.current += delta;
    const mesh = ring.current;
    if (!mesh || over.current) return;
    const t = age.current / length;
    mesh.visible = t >= 0 && t < 1;
    if (t >= 1) {
      over.current = true;
      return onDone();
    }
    if (t < 0) return;
    const scale = 0.5 + ease(t) * (effect.big ? 2.4 : 1.7);
    mesh.scale.set(scale, scale, scale);
    (mesh.material as MeshBasicMaterial).opacity = 0.95 * (1 - t);
  });
  return (
    <mesh ref={ring} visible={false} position={[effect.at.x, 0.06, effect.at.z]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.62, 0.86, 56]} />
      <meshBasicMaterial color={effect.colour} transparent opacity={0} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

const TRAIL = 5;

/** Something carried from one desk to another, in an arc over the walls. */
function Flight({
  effect,
  close,
  onDone,
}: {
  effect: Extract<Effect, { kind: "flight" }>;
  /** True when the viewer stands in the office, where what is carried can be smaller. */
  close: boolean;
  onDone: () => void;
}) {
  const parcel = useRef<Group>(null);
  const trail = useRef<(Mesh | null)[]>([]);
  const landing = useRef<Mesh>(null);
  const over = useRef(false);
  const age = useRef(-effect.delay);
  const distance = Math.hypot(effect.to.x - effect.from.x, effect.to.z - effect.from.z);
  const length = Math.min(2.6, 1.1 + distance * 0.07);
  const peak = 2.6 + distance * 0.11;
  // The route, as a point for each share of the way along it.
  const along = (k: number): [number, number, number] => [
    effect.from.x + (effect.to.x - effect.from.x) * k,
    DESK_TOP + Math.sin(Math.PI * k) * peak,
    effect.from.z + (effect.to.z - effect.from.z) * k,
  ];
  const at = (t: number): [number, number, number] => along(ease(Math.min(1, Math.max(0, t))));
  // A thin line along the whole route, so the eye can follow where the work is going.
  const route = useMemo(() => {
    const points = Array.from({ length: 33 }, (_, i) => new Vector3(...along(i / 32)));
    const material = new LineBasicMaterial({ color: effect.colour, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
    return new Line(new BufferGeometry().setFromPoints(points), material);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(
    () => () => {
      route.geometry.dispose();
      (route.material as LineBasicMaterial).dispose();
    },
    [route],
  );
  useFrame((_, delta) => {
    age.current += delta;
    const t = age.current / length;
    const group = parcel.current;
    if (!group || over.current) return;
    const flying = t >= 0 && t < 1;
    group.visible = flying;
    if (flying) {
      group.position.set(...at(t));
      group.rotation.y += delta * 5;
    }
    (route.material as LineBasicMaterial).opacity = t < 0 ? 0 : t < 1 ? 0.8 : Math.max(0, 0.8 * (1 - (t - 1) * 3));
    trail.current.forEach((dot, i) => {
      if (!dot) return;
      const lag = t - (i + 1) * 0.045;
      dot.visible = flying && lag > 0;
      if (dot.visible) dot.position.set(...at(lag));
    });
    // The desk it lands on answers with a ring.
    const ring = landing.current;
    if (ring) {
      const after = (age.current - length) / 0.9;
      ring.visible = after >= 0 && after < 1;
      if (ring.visible) {
        const scale = 0.5 + ease(after) * (effect.big ? 2.4 : 1.7);
        ring.scale.set(scale, scale, scale);
        (ring.material as MeshBasicMaterial).opacity = 0.95 * (1 - after);
      }
      if (after >= 1) {
        over.current = true;
        onDone();
      }
    }
  });
  const size = (effect.big ? 1 : 0.7) * (close ? 0.42 : 1);
  return (
    <>
      <primitive object={route} />
      <group ref={parcel} visible={false}>
        <mesh>
          <boxGeometry args={[0.82 * size, 0.14 * size, 0.56 * size]} />
          <meshBasicMaterial color={effect.colour} toneMapped={false} />
        </mesh>
      </group>
      {Array.from({ length: TRAIL }, (_, i) => (
        <mesh
          key={i}
          visible={false}
          ref={(mesh) => {
            trail.current[i] = mesh;
          }}
        >
          <sphereGeometry args={[0.15 * size * (1 - i / (TRAIL + 1)), 10, 10]} />
          <meshBasicMaterial color={effect.colour} transparent opacity={0.7 - i * 0.11} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
      <mesh ref={landing} visible={false} position={[effect.to.x, 0.06, effect.to.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.62, 0.86, 56]} />
        <meshBasicMaterial color={effect.colour} transparent opacity={0} depthWrite={false} toneMapped={false} />
      </mesh>
    </>
  );
}

/** More new lines than this at once is a jump in the record, such as a reset, and is not replayed. */
const MOST_AT_ONCE = 14;

export function WorkInMotion({
  office,
  seat,
  close = false,
}: {
  /** True on foot. Marks are drawn large enough to read from above, and smaller for someone among them. */
  close?: boolean;
  office: Office;
  /** Where a person or an agent sits, or null when they have no desk. */
  seat: (participantId: string) => Spot | null;
}) {
  const seen = useRef<Set<string> | null>(null);
  const [effects, setEffects] = useState<Effect[]>([]);
  const seatRef = useRef(seat);
  seatRef.current = seat;

  useEffect(() => {
    // The first look at an office only notes what is already there.
    if (seen.current === null) {
      seen.current = new Set(office.messages.map((m) => m.id));
      return;
    }
    const known = seen.current;
    const fresh = office.messages.filter((m) => !known.has(m.id));
    for (const m of fresh) known.add(m.id);
    if (fresh.length === 0 || fresh.length > MOST_AT_ONCE) return;
    // People who ask for less motion get the desks' lamps and folders, which stand still.
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const made = fresh
      .flatMap((m) => effectsOf(office, m, seatRef.current))
      .map((mark, i): Effect => ({ ...mark, delay: i * 0.28 }));
    if (made.length > 0) setEffects((now) => [...now, ...made].slice(-40));
  }, [office]);

  const done = (id: string): void => setEffects((now) => now.filter((e) => e.id !== id));
  return (
    <>
      {effects.map((effect) =>
        effect.kind === "ping" ? (
          <Ping key={effect.id} effect={effect} onDone={() => done(effect.id)} />
        ) : (
          <Flight key={effect.id} effect={effect} close={close} onDone={() => done(effect.id)} />
        ),
      )}
    </>
  );
}
