"use client";

import { useEffect, useMemo, useRef, type RefObject } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, ContactShadows } from "@react-three/drei";
import { Fog, PerspectiveCamera, Vector3 } from "three";
import type { Office } from "../lib/model";
import { deskState, type AgentLoad } from "../lib/agentState";
import { taskLabel } from "../lib/taskLabels";
import { planExtent, roomCentre, seatPosition, type WalkPose } from "../lib/geometry";
import { KindBadge } from "./Panels";
import { RoomMesh } from "./RoomMesh";
import { DeskMesh, type DeskFolder } from "./Desk";
import { Figure } from "./Figure";
import { statusOf } from "./TaskCard";
import { WorkInMotion } from "./WorkInMotion";
import { WalkControls } from "./WalkControls";
import { LabelLayer, LabelProjector, type LabelSpec } from "./Labels";

const FOV = 34;
/** How many of a desk's tasks are named at its foot before the rest are counted. */
const CHIPS_SHOWN = 4;
/** The plan has no ceiling, so on foot the space above the walls is open sky. */
const WALK_SKY = "#a9b3bd";
/** Screen width taken by the left column and by the inspector, margins included. */
const LEFT_PANEL = 276;
const RIGHT_PANEL = 358;
/** Below this width the panels are sheets over the office and take no strip of their own. */
const PHONE_WIDTH = 720;
/** Direction from the orbit target to the camera's resting position. */
const VIEW_DIRECTION = new Vector3(1, 28, 26.8).normalize();

/**
 * Pulls the camera back until the near edge of the plan fits in the strip of
 * screen between the panels. Refits on resize until the viewer takes over the
 * camera, after which their framing is left alone.
 */
function Framing({
  target,
  nearEdge,
  planWidth,
  touched,
  inspectorOpen,
}: {
  target: Vector3;
  nearEdge: Vector3;
  planWidth: number;
  touched: RefObject<boolean>;
  /** Whether the inspector is taking its strip on the right. */
  inspectorOpen: boolean;
}) {
  const { camera, scene, size } = useThree();

  useEffect(() => {
    const phone = size.width <= PHONE_WIDTH;
    const left = phone ? 0 : LEFT_PANEL;
    const right = phone || !inspectorOpen ? 0 : RIGHT_PANEL;
    // The picture is slid sideways so its middle is the middle of the strip
    // the panels leave free. Without this the plan sits under the wider panel.
    if (camera instanceof PerspectiveCamera) {
      camera.setViewOffset(size.width, size.height, (right - left) / 2, 0, size.width, size.height);
    }
    if (touched.current) return;
    const free = Math.max(240, size.width - left - right) * 0.86;
    const halfTan = Math.tan((FOV * Math.PI) / 360);
    const lead = nearEdge.clone().sub(target).dot(VIEW_DIRECTION);
    const fit = lead + (planWidth * size.height) / (2 * halfTan * free);
    // Far enough back that a long corridor still fits between the panels.
    const distance = Math.min(Math.max(fit, 30), 320);

    camera.position.copy(target).addScaledVector(VIEW_DIRECTION, distance);
    camera.lookAt(target);
    if (camera instanceof PerspectiveCamera) camera.updateProjectionMatrix();
    if (scene.fog instanceof Fog) {
      scene.fog.near = distance + 14;
      scene.fog.far = distance + 64;
    }
  }, [camera, scene, size.width, size.height, target, nearEdge, planWidth, touched, inspectorOpen]);

  // On foot the picture is not slid: the walker looks straight ahead.
  useEffect(
    () => () => {
      if (camera instanceof PerspectiveCamera) camera.clearViewOffset();
    },
    [camera],
  );

  return null;
}

export function Scene({
  office,
  viewerId,
  mode,
  walkPose,
  walkRoomId,
  onWalkRoomChange,
  selectedId,
  onSelectParticipant,
  onSelectRoom,
  closedRooms,
  onFaceParticipant,
  onInteract,
  roomHighlight,
  participantAlert,
  inspectorOpen,
  agentLoad,
  onSelectTask,
}: {
  /** What each agent is taking a step on right now. */
  agentLoad: AgentLoad;
  /** A task's folder on a desk was pressed. */
  onSelectTask: (taskId: string) => void;
  /** Whether the inspector is showing, which narrows the strip the office is framed in. */
  inspectorOpen: boolean;
  office: Office;
  /** The signed-in person, whose own name tag says so. */
  viewerId: string;
  /** Overview orbits the whole plan. Walk puts the camera at eye level. */
  mode: "overview" | "walk";
  walkPose: RefObject<WalkPose>;
  /** The room the walker is standing in, or null when outside. */
  walkRoomId: string | null;
  onWalkRoomChange: (roomId: string | null) => void;
  selectedId: string | null;
  onSelectParticipant: (id: string) => void;
  onSelectRoom: (id: string) => void;
  /** Rooms the signed-in person may not enter. */
  closedRooms: ReadonlySet<string>;
  /** While walking: who the walker is close to and facing, or null. */
  onFaceParticipant: (id: string | null) => void;
  /** While walking: the walker pressed the key to talk to whoever they face. */
  onInteract: (id: string) => void;
  roomHighlight: (roomId: string) => "none" | "question" | "permission";
  participantAlert: (id: string) => "none" | "question" | "permission";
}) {
  const { rooms, desks } = office.floorplan;
  const ext = planExtent(rooms);
  const cx = (ext.minX + ext.maxX) / 2;
  const cz = (ext.minZ + ext.maxZ) / 2;

  const deskById = Object.fromEntries(desks.map((d) => [d.id, d]));

  // Recomputed when rooms are added or removed, so the framing follows the plan.
  const target = useMemo(() => new Vector3(cx + 0.5, 0, cz + 1.2), [cx, cz]);
  const nearEdge = useMemo(() => new Vector3(cx, 0, ext.maxZ), [cx, ext.maxZ]);
  const cameraTouched = useRef(false);

  // Each occupied desk's monitor shows what its occupant is doing right now.
  const screens = useMemo(
    () =>
      Object.fromEntries(
        office.participants
          .filter((p) => p.deskId)
          .map((p) => [p.deskId as string, { name: p.displayName, state: deskState(office, p) }]),
      ),
    [office],
  );
  // Where each seated person is, for finding who the walker is facing.
  const seats = useMemo(
    () =>
      office.participants.flatMap((p) => {
        const desk = p.deskId ? desks.find((d) => d.id === p.deskId) : null;
        if (!desk || p.id === viewerId) return [];
        const seat = seatPosition(desk);
        return [{ id: p.id, x: seat.x, z: seat.z, roomId: desk.roomId }];
      }),
    [office.participants, desks, viewerId],
  );
  // Every open task lies on the desk of whoever holds it, in the colour of its state.
  const folders = useMemo(() => {
    const byDesk: Record<string, DeskFolder[]> = {};
    for (const task of office.tasks) {
      if (task.closedAt !== null || !task.ownerId) continue;
      const deskId = office.participants.find((p) => p.id === task.ownerId)?.deskId;
      if (!deskId) continue;
      const status = statusOf(task);
      (byDesk[deskId] ??= []).push({
        id: task.id,
        label: taskLabel(office, task.id),
        hint: `${task.title} (${status.label})`,
        colour: status.accent,
        urgent: task.urgent === true,
      });
    }
    // What is being worked on right now comes first, then what is urgent.
    const inHand = new Set(Object.values(agentLoad).flatMap((load) => (load.taskId ? [load.taskId] : [])));
    const weight = (folder: DeskFolder): number => (inHand.has(folder.id) ? 0 : folder.urgent ? 1 : 2);
    for (const held of Object.values(byDesk)) held.sort((a, b) => weight(a) - weight(b));
    return byDesk;
  }, [office, agentLoad]);
  const busy = (participantId: string | undefined): boolean =>
    participantId !== undefined && (agentLoad[participantId]?.taskId ?? null) !== null;
  const seatOf = (participantId: string): { x: number; z: number } | null => {
    const deskId = office.participants.find((p) => p.id === participantId)?.deskId;
    const desk = deskId ? deskById[deskId] : null;
    return desk ? seatPosition(desk) : null;
  };

  const walking = mode === "walk";
  // Coming back from a walk always returns to the fitted overview.
  if (walking) cameraTouched.current = false;

  // Room names lie on the floor in the overview. Name tags float above each
  // head; on foot they show only for people in the room the walker is in.
  const labelElements = useRef(new Map<string, HTMLDivElement>());
  const labels = useMemo<LabelSpec[]>(() => {
    const roomLabels: LabelSpec[] = rooms.map((room) => ({
      id: `room:${room.id}`,
      // Along the near edge of the floor, where name tags above the desks
      // do not cover it however full the room is.
      position: [roomCentre(room).cx, 0.06, room.bounds.z + room.bounds.d - 0.75],
      hidden: walking,
      fullSizeAt: 46,
      node: (
        <div className="room-label">
          <div className="name">{room.name}</div>
          <div className="purpose">{room.purpose}</div>
        </div>
      ),
    }));
    const nameTags: LabelSpec[] = office.participants.flatMap((p) => {
      const desk = p.deskId ? desks.find((d) => d.id === p.deskId) : null;
      if (!desk) return [];
      const seat = seatPosition(desk);
      return [
        {
          id: `tag:${p.id}`,
          position: [seat.x, 1.95, seat.z] as [number, number, number],
          hidden: walking && desk.roomId !== walkRoomId,
          node: (
            <div className="name-tag">
              <KindBadge kind={p.kind} agentType={p.agentType} />
              {p.displayName}
              {p.id === viewerId && <span className="you">(You)</span>}
              {agentLoad[p.id]?.taskId && (
                <span className="at-task">
                  {agentLoad[p.id].forNote ? "note on" : "on"} {taskLabel(office, agentLoad[p.id].taskId!)}
                </span>
              )}
            </div>
          ),
        },
      ];
    });
    // The open tasks each person or agent holds, as chips at the foot of their desk.
    // On foot the folders on the desk are close enough to read by themselves.
    const work: LabelSpec[] = walking
      ? []
      : office.participants.flatMap((p) => {
          const desk = p.deskId ? desks.find((d) => d.id === p.deskId) : null;
          const held = desk ? (folders[desk.id] ?? []) : [];
          if (!desk || held.length === 0) return [];
          const seat = seatPosition(desk);
          return [
            {
              id: `work:${p.id}`,
              position: [seat.x, 0, seat.z] as [number, number, number],
              node: (
                <div className="desk-work">
                  {held.slice(0, CHIPS_SHOWN).map((folder) => (
                    <button
                      key={folder.id}
                      type="button"
                      className="desk-chip"
                      data-urgent={folder.urgent}
                      style={{ ["--accent" as string]: folder.colour }}
                      title={folder.hint}
                      onClick={() => onSelectTask(folder.id)}
                    >
                      {folder.label}
                    </button>
                  ))}
                  {held.length > CHIPS_SHOWN && <span className="desk-more">+{held.length - CHIPS_SHOWN}</span>}
                </div>
              ),
            },
          ];
        });
    return [...roomLabels, ...nameTags, ...work];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, desks, office.participants, office.tasks, agentLoad, folders, walking, walkRoomId, viewerId]);

  return (
    <>
    <Canvas
      shadows
      camera={{ position: [cx + 1.5, 28, cz + 28], fov: FOV }}
      gl={{ antialias: true }}
      style={{ position: "absolute", inset: 0 }}
    >
      <LabelProjector specs={labels} elements={labelElements} />
      <color attach="background" args={[walking ? WALK_SKY : "#16181d"]} />
      <fog attach="fog" args={[walking ? WALK_SKY : "#16181d", 48, 96]} />
      {walking ? (
        <WalkControls
          floorplan={office.floorplan}
          pose={walkPose}
          onRoomChange={onWalkRoomChange}
          seats={seats}
          closedRooms={closedRooms}
          onFace={onFaceParticipant}
          onInteract={onInteract}
        />
      ) : (
        <Framing
          target={target}
          nearEdge={nearEdge}
          planWidth={ext.maxX - ext.minX + 1}
          touched={cameraTouched}
          inspectorOpen={inspectorOpen}
        />
      )}

      <ambientLight intensity={0.92} />
      <hemisphereLight args={["#fff4e4", "#3a3f4a", 0.55]} />
      <directionalLight
        position={[cx + 16, 30, cz + 14]}
        intensity={0.72}
        color="#fff6e8"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0006}
        shadow-camera-left={-28}
        shadow-camera-right={28}
        shadow-camera-top={28}
        shadow-camera-bottom={-28}
      />
      <directionalLight position={[cx - 18, 16, cz - 14]} intensity={0.22} color="#cfd8ff" />

      {/* ground slab under the whole plan */}
      <mesh position={[cx, -0.06, cz]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[ext.maxX - ext.minX + 6, ext.maxZ - ext.minZ + 6]} />
        <meshStandardMaterial color="#20242b" roughness={1} />
      </mesh>

      {rooms.map((room) => (
        <RoomMesh
          key={room.id}
          room={room}
          highlight={roomHighlight(room.id)}
          walking={walking}
          barred={closedRooms.has(room.id)}
          onSelect={() => onSelectRoom(room.id)}
        />
      ))}

      {desks.map((desk) => (
        <DeskMesh
          key={desk.id}
          desk={desk}
          screen={screens[desk.id] ?? null}
          active={busy(office.participants.find((p) => p.deskId === desk.id)?.id)}
          folders={folders[desk.id]}
          onOpenTask={onSelectTask}
        />
      ))}

      {office.participants.map((p) => {
        const desk = p.deskId ? deskById[p.deskId] : null;
        if (!desk) return null;
        // The seat sits behind the desk origin in the desk's own frame, so
        // rotating a desk moves its occupant with it.
        const seat = seatPosition(desk);
        return (
          <Figure
            key={p.id}
            participant={p}
            position={[seat.x, seat.z]}
            facing={desk.facing + Math.PI}
            selected={selectedId === p.id}
            alert={participantAlert(p.id)}
            working={busy(p.id)}
            onSelect={() => onSelectParticipant(p.id)}
          />
        );
      })}

      <WorkInMotion key={office.id} office={office} seat={seatOf} close={walking} />

      <ContactShadows
        position={[cx, 0.02, cz]}
        scale={46}
        opacity={0.22}
        blur={2.4}
        far={5}
      />

      {!walking && (
        <OrbitControls
          target={target}
          onStart={() => {
            cameraTouched.current = true;
          }}
          maxPolarAngle={Math.PI / 2.15}
          minDistance={10}
          maxDistance={120}
          enableDamping
          dampingFactor={0.08}
        />
      )}
    </Canvas>
    <LabelLayer specs={labels} elements={labelElements} />
    </>
  );
}
