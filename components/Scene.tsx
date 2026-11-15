"use client";

import { useEffect, useMemo, useRef, type RefObject } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, ContactShadows } from "@react-three/drei";
import { Fog, PerspectiveCamera, Vector3 } from "three";
import type { Office } from "../lib/model";
import { deskState } from "../lib/agentState";
import { planExtent, roomCentre, seatPosition, type WalkPose } from "../lib/geometry";
import { KindBadge } from "./Panels";
import { RoomMesh } from "./RoomMesh";
import { DeskMesh } from "./Desk";
import { Figure } from "./Figure";
import { WalkControls } from "./WalkControls";
import { LabelLayer, LabelProjector, type LabelSpec } from "./Labels";

const FOV = 34;
/** The plan has no ceiling, so on foot the space above the walls is open sky. */
const WALK_SKY = "#a9b3bd";
/** Screen width taken by the left column and the inspector, margins included. */
const PANEL_WIDTH = 634;
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
}: {
  target: Vector3;
  nearEdge: Vector3;
  planWidth: number;
  touched: RefObject<boolean>;
}) {
  const { camera, scene, size } = useThree();

  useEffect(() => {
    if (touched.current) return;
    const free = Math.max(320, size.width - PANEL_WIDTH) * 0.96;
    const halfTan = Math.tan((FOV * Math.PI) / 360);
    const lead = nearEdge.clone().sub(target).dot(VIEW_DIRECTION);
    const fit = lead + (planWidth * size.height) / (2 * halfTan * free);
    const distance = Math.min(Math.max(fit, 30), 110);

    camera.position.copy(target).addScaledVector(VIEW_DIRECTION, distance);
    camera.lookAt(target);
    if (camera instanceof PerspectiveCamera) camera.updateProjectionMatrix();
    if (scene.fog instanceof Fog) {
      scene.fog.near = distance + 14;
      scene.fog.far = distance + 64;
    }
  }, [camera, scene, size.width, size.height, target, nearEdge, planWidth, touched]);

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
}: {
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
            </div>
          ),
        },
      ];
    });
    return [...roomLabels, ...nameTags];
  }, [rooms, desks, office.participants, walking, walkRoomId, viewerId]);

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
        <DeskMesh key={desk.id} desk={desk} screen={screens[desk.id] ?? null} />
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
            onSelect={() => onSelectParticipant(p.id)}
          />
        );
      })}

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
