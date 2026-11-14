"use client";

import { useEffect, useRef } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, ContactShadows } from "@react-three/drei";
import { Fog, PerspectiveCamera, Vector3 } from "three";
import type { Office } from "../lib/model";
import { planExtent } from "../lib/geometry";
import { RoomMesh } from "./RoomMesh";
import { DeskMesh } from "./Desk";
import { Figure } from "./Figure";

const FOV = 34;
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
  touched: React.MutableRefObject<boolean>;
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
  selectedId,
  onSelectParticipant,
  onSelectRoom,
  roomHighlight,
  participantAlert,
}: {
  office: Office;
  selectedId: string | null;
  onSelectParticipant: (id: string) => void;
  onSelectRoom: (id: string) => void;
  roomHighlight: (roomId: string) => "none" | "question" | "permission";
  participantAlert: (id: string) => "none" | "question" | "permission";
}) {
  const { rooms, desks } = office.floorplan;
  const ext = planExtent(rooms);
  const cx = (ext.minX + ext.maxX) / 2;
  const cz = (ext.minZ + ext.maxZ) / 2;

  const deskById = Object.fromEntries(desks.map((d) => [d.id, d]));

  const target = useRef(new Vector3(cx + 0.5, 0, cz + 1.2)).current;
  const nearEdge = useRef(new Vector3(cx, 0, ext.maxZ)).current;
  const cameraTouched = useRef(false);

  return (
    <Canvas
      shadows
      camera={{ position: [cx + 1.5, 28, cz + 28], fov: FOV }}
      gl={{ antialias: true }}
      style={{ position: "absolute", inset: 0 }}
    >
      <color attach="background" args={["#16181d"]} />
      <fog attach="fog" args={["#16181d", 48, 96]} />
      <Framing
        target={target}
        nearEdge={nearEdge}
        planWidth={ext.maxX - ext.minX + 1}
        touched={cameraTouched}
      />

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
          onSelect={() => onSelectRoom(room.id)}
        />
      ))}

      {desks.map((desk) => (
        <DeskMesh key={desk.id} desk={desk} />
      ))}

      {office.participants.map((p) => {
        const desk = p.deskId ? deskById[p.deskId] : null;
        if (!desk) return null;
        // The seat sits behind the desk origin in the desk's own frame, so
        // rotating a desk moves its occupant with it.
        const seat = 0.32;
        const sx = desk.position.x + seat * Math.sin(desk.facing);
        const sz = desk.position.z + seat * Math.cos(desk.facing);
        return (
          <Figure
            key={p.id}
            participant={p}
            position={[sx, sz]}
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
    </Canvas>
  );
}
