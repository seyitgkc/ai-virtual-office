"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group, Mesh, MeshStandardMaterial } from "three";
import type { Participant } from "../lib/model";
import { CLICK_SLOP } from "./RoomMesh";

/**
 * A person or an agent at a desk. The two read differently on purpose: people
 * are rounded and solid, agents are faceted and carry a slowly turning ring,
 * so you can tell at a glance who in the room is synthetic.
 */
export function Figure({
  participant,
  position,
  facing,
  selected,
  alert,
  working = false,
  onSelect,
}: {
  /** True while an agent is taking a step: it leans to its desk and its ring runs fast and bright. */
  working?: boolean;
  participant: Participant;
  position: [number, number];
  facing: number;
  selected: boolean;
  alert: "none" | "question" | "permission";
  onSelect: () => void;
}) {
  const ring = useRef<Mesh>(null);
  const pulse = useRef<Mesh>(null);
  const torso = useRef<Group>(null);
  const isAgent = participant.kind === "agent";

  useFrame((state, delta) => {
    if (ring.current) {
      ring.current.rotation.z += delta * (working ? 4.2 : 0.6);
      (ring.current.material as MeshStandardMaterial).emissiveIntensity = working
        ? 1.6 + Math.sin(state.clock.elapsedTime * 7) * 0.5
        : 0.55;
    }
    if (torso.current) {
      // At work the figure leans in over the desk and moves a little, as someone typing does.
      const lean = working ? 0.16 : 0;
      torso.current.rotation.x += (lean - torso.current.rotation.x) * Math.min(1, delta * 6);
      torso.current.position.y = working ? Math.abs(Math.sin(state.clock.elapsedTime * 9)) * 0.022 : 0;
    }
    if (pulse.current) {
      const t = state.clock.elapsedTime;
      const s = 1 + Math.sin(t * 2.4) * 0.12;
      pulse.current.scale.set(s, s, s);
    }
  });

  const [x, z] = position;
  const colour = participant.appearance.color;
  const alertColour =
    alert === "permission" ? "#e0614f" : alert === "question" ? "#e0a23f" : null;

  return (
    <group position={[x, 0, z]} rotation={[0, facing, 0]}>
      <group
        onClick={(e) => {
          e.stopPropagation();
          if (e.delta <= CLICK_SLOP) onSelect();
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          document.body.style.cursor = "auto";
        }}
      >
        <group ref={torso}>
        {/* body */}
        <mesh position={[0, 0.42, 0]} castShadow>
          {isAgent ? (
            <cylinderGeometry args={[0.2, 0.26, 0.84, 6]} />
          ) : (
            <capsuleGeometry args={[0.19, 0.46, 4, 12]} />
          )}
          <meshStandardMaterial
            color={colour}
            roughness={isAgent ? 0.35 : 0.72}
            metalness={isAgent ? 0.45 : 0.05}
          />
        </mesh>

        {/* head */}
        <mesh position={[0, 1.02, 0]} castShadow>
          {isAgent ? (
            <octahedronGeometry args={[0.17, 0]} />
          ) : (
            <sphereGeometry args={[0.17, 16, 16]} />
          )}
          <meshStandardMaterial
            color={colour}
            roughness={isAgent ? 0.3 : 0.65}
            metalness={isAgent ? 0.5 : 0.05}
          />
        </mesh>

        {/* agents carry a turning ring */}
        {isAgent && (
          <mesh ref={ring} position={[0, 1.33, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.21, 0.016, 8, 32]} />
            <meshStandardMaterial
              color={colour}
              emissive={colour}
              emissiveIntensity={0.55}
              roughness={0.3}
            />
          </mesh>
        )}
        </group>
      </group>

      {/* selection ring on the floor */}
      {selected && (
        <mesh position={[0, 0.015, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.38, 0.46, 40]} />
          <meshBasicMaterial color="#f5f1e8" transparent opacity={0.9} />
        </mesh>
      )}

      {/* something needs a human */}
      {alertColour && (
        <mesh ref={pulse} position={[0, 1.66, 0]}>
          <sphereGeometry args={[0.1, 14, 14]} />
          <meshStandardMaterial
            color={alertColour}
            emissive={alertColour}
            emissiveIntensity={1.1}
          />
        </mesh>
      )}
    </group>
  );
}
