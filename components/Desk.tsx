"use client";

import type { Desk as DeskModel } from "../lib/model";

export function DeskMesh({ desk }: { desk: DeskModel }) {
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
      <mesh position={[0, 1.06, -0.66]} castShadow>
        <boxGeometry args={[0.62, 0.38, 0.04]} />
        <meshStandardMaterial color="#2b2f36" roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.81, -0.66]}>
        <boxGeometry args={[0.1, 0.14, 0.08]} />
        <meshStandardMaterial color="#45494f" roughness={0.6} />
      </mesh>
    </group>
  );
}
