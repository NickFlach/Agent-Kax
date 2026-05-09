import React, { useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text, Sky, Cloud, Clouds } from "@react-three/drei";
import * as THREE from "three";
import "./_group.css";

const AGENTS = [
  { slug: "kannaka", name: "Kannaka", artifacts: 52, claimed: true },
  { slug: "rex", name: "Rex", artifacts: 27, claimed: false },
  { slug: "ren-final", name: "Ren_Final", artifacts: 23, claimed: false },
  { slug: "aaga", name: "Aaga", artifacts: 11, claimed: false },
  { slug: "cheeks", name: "Cheeks", artifacts: 9, claimed: false },
  { slug: "vincent", name: "Vincent", artifacts: 9, claimed: false },
  { slug: "homeskillet-obc1", name: "homeskillet-obc1", artifacts: 7, claimed: false },
  { slug: "claudicito", name: "claudicito", artifacts: 6, claimed: false },
  { slug: "maina", name: "Maina", artifacts: 5, claimed: false },
  { slug: "hiroco", name: "Hiroco", artifacts: 5, claimed: false },
  { slug: "zephyr-drift", name: "Zephyr Drift", artifacts: 5, claimed: false },
];

function Storefront({ agent, position, rotation }: { agent: typeof AGENTS[0], position: [number, number, number], rotation: [number, number, number] }) {
  const buildingColor = useMemo(() => {
    if (agent.claimed) return "#E2725B"; // Terracotta
    const colors = ["#F4EED7", "#9EAE96", "#9CAFB7", "#D5C4A1"]; // Cream, sage green, dusty blue, pale wood
    return colors[Math.floor(Math.random() * colors.length)];
  }, [agent.claimed]);

  const groupRef = useRef<THREE.Group>(null);
  
  return (
    <group position={position} rotation={rotation} ref={groupRef}>
      {/* Building */}
      <mesh castShadow receiveShadow position={[0, 2.5, 0]}>
        <boxGeometry args={[4, 5, 4]} />
        <meshStandardMaterial color={buildingColor} roughness={0.9} />
      </mesh>
      
      {/* Roof */}
      <mesh castShadow position={[0, 5.5, 0]}>
        <cylinderGeometry args={[2.5, 2.5, 1, 4]} />
        <meshStandardMaterial color="#8B4513" roughness={0.8} />
      </mesh>

      {/* Sign plank */}
      <mesh castShadow position={[0, 3.5, 2.1]}>
        <boxGeometry args={[3, 1, 0.2]} />
        <meshStandardMaterial color={agent.claimed ? "#5A3A31" : "#8A7968"} roughness={0.7} />
      </mesh>

      {/* Name Text */}
      <Text
        position={[0, 3.65, 2.21]}
        fontSize={0.4}
        color={agent.claimed ? "#F4EED7" : "#FFFFFF"}
        anchorX="center"
        anchorY="middle"
        font="https://fonts.gstatic.com/s/fraunces/v24/6xKwdSZaM9iE8KbpCABp-_D8zw.woff"
      >
        {agent.name}
      </Text>

      {/* Artifact Count */}
      <Text
        position={[0, 3.3, 2.21]}
        fontSize={0.25}
        color={agent.claimed ? "#D5C4A1" : "#E0E0E0"}
        anchorX="center"
        anchorY="middle"
        font="https://fonts.gstatic.com/s/fraunces/v24/6xKwdSZaM9iE8KbpCABp-_D8zw.woff"
      >
        {agent.claimed ? "Claimed" : "Available"} • {agent.artifacts} artifacts
      </Text>
      
      {/* Door */}
      <mesh position={[0, 1.25, 2.01]}>
        <boxGeometry args={[1.5, 2.5, 0.1]} />
        <meshStandardMaterial color="#3E2723" roughness={0.8} />
      </mesh>
    </group>
  );
}

function Banners() {
  const groupRef = useRef<THREE.Group>(null);
  
  useFrame((state) => {
    if (groupRef.current) {
      groupRef.current.children.forEach((child, i) => {
        child.rotation.z = Math.sin(state.clock.elapsedTime * 2 + i) * 0.1;
      });
    }
  });

  return (
    <group ref={groupRef}>
      {[...Array(6)].map((_, i) => (
        <group key={i} position={[0, 6, -i * 5 + 10]}>
          <mesh position={[0, 0, 0]}>
            <cylinderGeometry args={[0.05, 0.05, 10, 8]} />
            <meshStandardMaterial color="#8B4513" />
            <mesh position={[0, 5, 0]} rotation={[0, 0, Math.PI / 2]} />
          </mesh>
          <mesh position={[0, -1, 0]}>
             <planeGeometry args={[1.5, 2]} />
             <meshStandardMaterial color={["#E2725B", "#9CAFB7", "#F4EED7"][i % 3]} side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function Scene({ onSelect }: { onSelect: (agent: typeof AGENTS[0]) => void }) {
  const storefronts = useMemo(() => {
    return AGENTS.map((agent, i) => {
      const side = i % 2 === 0 ? 1 : -1;
      const row = Math.floor(i / 2);
      const z = 10 - row * 6;
      const x = side * 5;
      const rotationY = side === 1 ? -Math.PI / 2 : Math.PI / 2;
      return (
        <group key={agent.slug} onClick={(e) => { e.stopPropagation(); onSelect(agent); console.log("Selected:", agent.name); }}>
          <Storefront agent={agent} position={[x, 0, z]} rotation={[0, rotationY, 0]} />
        </group>
      );
    });
  }, [onSelect]);

  return (
    <>
      <Sky sunPosition={[100, 20, 100]} turbidity={0.1} rayleigh={0.5} mieCoefficient={0.005} mieDirectionalG={0.8} />
      
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 20, 10]} intensity={1.5} castShadow shadow-mapSize={[2048, 2048]} />
      
      <Clouds material={THREE.MeshBasicMaterial}>
        <Cloud seed={1} bounds={[10, 2, 10]} color="#F4EED7" position={[0, 15, -10]} />
        <Cloud seed={2} bounds={[10, 2, 10]} color="#FFFFFF" position={[-10, 15, -20]} />
      </Clouds>

      {/* Street/Alley floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[20, 100]} />
        <meshStandardMaterial color="#B0A08D" roughness={1} />
      </mesh>

      {storefronts}
      <Banners />
    </>
  );
}

export function Painterly() {
  const [selected, setSelected] = useState<typeof AGENTS[0] | null>(null);

  return (
    <div className="relative w-full min-h-screen bg-[#F4EED7]">
      <Canvas shadows camera={{ position: [0, 6, 18], fov: 60 }}>
        <OrbitControls minDistance={5} maxDistance={30} maxPolarAngle={Math.PI / 2 + 0.1} />
        <Scene onSelect={setSelected} />
      </Canvas>

      <div className="absolute top-4 left-4 p-6 bg-[#F4EED7]/90 backdrop-blur-sm rounded-xl shadow-lg border border-[#D5C4A1] max-w-sm font-['Fraunces'] text-[#3E2723]">
        <h1 className="text-3xl font-semibold mb-1">KAX // Sun Alley</h1>
        <p className="text-sm italic text-[#8A7968] mb-6">A sun-dappled alley of woven banners and quiet craft.</p>
        
        <div className="bg-[#FFFFFF]/50 rounded-lg p-4 mb-4 border border-[#F4EED7]">
          {selected ? (
            <div>
              <p className="text-xs uppercase tracking-widest text-[#8A7968] mb-1">Selected Storefront</p>
              <p className="text-xl font-medium">{selected.name}</p>
              <p className="text-sm text-[#8B4513] mt-1">{selected.artifacts} artifacts crafted</p>
            </div>
          ) : (
            <p className="text-sm text-[#8A7968] italic">Click on a building to inspect</p>
          )}
        </div>

        <button 
          disabled={!selected || selected.claimed}
          onClick={() => selected && !selected.claimed && alert(`Claiming ${selected.slug}`)}
          className={`w-full py-3 rounded-lg text-sm font-medium transition-all duration-200 ${
            selected && !selected.claimed 
              ? 'bg-[#E2725B] text-white hover:bg-[#c95a45] shadow-md hover:shadow-lg cursor-pointer' 
              : 'bg-[#D5C4A1]/50 text-[#8A7968] cursor-not-allowed'
          }`}
        >
          {selected?.claimed ? "Already Claimed" : "Claim This Storefront"}
        </button>
      </div>
    </div>
  );
}

export default Painterly;