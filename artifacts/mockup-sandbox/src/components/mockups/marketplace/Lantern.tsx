import React, { useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text, Html, Sky, Sparkles, Box, Cylinder, Sphere } from "@react-three/drei";
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

function Storefront({ agent, position, rotation, onSelect, isSelected }: any) {
  const isClaimed = agent.claimed;
  
  const roofColor = isClaimed ? "#B31B1B" : "#4A4A4A";
  const buildingColor = isClaimed ? "#8B1010" : "#2A2A2A";
  const trimColor = isClaimed ? "#D4AF37" : "#555555";
  const signColor = isClaimed ? "#222222" : "#111111";
  
  return (
    <group position={position} rotation={rotation} onClick={() => onSelect(agent)}>
      {/* Main Building Body */}
      <Box args={[4, 5, 4]} position={[0, 2.5, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={buildingColor} />
      </Box>

      {/* Decorative Trim */}
      <Box args={[4.2, 0.2, 4.2]} position={[0, 0.1, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={trimColor} />
      </Box>
      <Box args={[4.2, 0.2, 4.2]} position={[0, 4.9, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={trimColor} />
      </Box>

      {/* Slanted Roof (Simple approximation of upturned eaves) */}
      <Cylinder args={[0, 3.5, 2, 4]} position={[0, 6, 0]} rotation={[0, Math.PI / 4, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={roofColor} />
      </Cylinder>
      
      {/* Eaves extension */}
      <Box args={[5, 0.2, 5]} position={[0, 5, 0]} castShadow receiveShadow>
         <meshStandardMaterial color={roofColor} />
      </Box>

      {/* Signage Plank */}
      <Box args={[3, 0.8, 0.2]} position={[0, 3.5, 2.1]} castShadow receiveShadow>
        <meshStandardMaterial color={signColor} />
      </Box>
      
      <Text
        position={[0, 3.6, 2.22]}
        fontSize={0.4}
        color={trimColor}
        anchorX="center"
        anchorY="middle"
        font="https://fonts.gstatic.com/s/cormorantgaramond/v16/co3bmX5slCNuHLi8bLeY9MK7whWMhyjYpHtK.woff"
      >
        {agent.name}
      </Text>
      
      <Text
        position={[0, 3.2, 2.22]}
        fontSize={0.2}
        color={isClaimed ? "#FFD700" : "#888888"}
        anchorX="center"
        anchorY="middle"
        font="https://fonts.gstatic.com/s/cormorantgaramond/v16/co3bmX5slCNuHLi8bLeY9MK7whWMhyjYpHtK.woff"
      >
        {agent.artifacts} artifacts {isClaimed ? "" : "(Available)"}
      </Text>

      {/* Selection Highlight */}
      {isSelected && (
        <Box args={[4.4, 5.2, 4.4]} position={[0, 2.5, 0]}>
          <meshBasicMaterial color="#FFD700" wireframe />
        </Box>
      )}
      
      {/* Entry glow / Light */}
      <pointLight position={[0, 2, 2.5]} distance={5} intensity={isClaimed ? 2 : 0.5} color={isClaimed ? "#FF4400" : "#AAAAAA"} />
    </group>
  );
}

function LanternProp({ position }: { position: [number, number, number] }) {
  const ref = useRef<THREE.Group>(null);
  
  useFrame(({ clock }) => {
    if (ref.current) {
      ref.current.rotation.x = Math.sin(clock.getElapsedTime() * 2 + position[0]) * 0.1;
      ref.current.rotation.z = Math.cos(clock.getElapsedTime() * 1.5 + position[2]) * 0.1;
    }
  });

  return (
    <group position={position} ref={ref}>
      <Cylinder args={[0.02, 0.02, 1]} position={[0, 0.5, 0]}>
        <meshBasicMaterial color="#222" />
      </Cylinder>
      <Sphere args={[0.3, 16, 16]} position={[0, 0, 0]}>
        <meshStandardMaterial color="#FF2200" emissive="#FF2200" emissiveIntensity={0.5} />
      </Sphere>
      <Cylinder args={[0.15, 0.15, 0.1]} position={[0, 0.35, 0]}>
        <meshStandardMaterial color="#D4AF37" />
      </Cylinder>
      <Cylinder args={[0.15, 0.15, 0.1]} position={[0, -0.35, 0]}>
        <meshStandardMaterial color="#D4AF37" />
      </Cylinder>
      {/* Tassel */}
      <Cylinder args={[0.05, 0.05, 0.4]} position={[0, -0.6, 0]}>
        <meshStandardMaterial color="#B31B1B" />
      </Cylinder>
      <pointLight position={[0, 0, 0]} distance={4} intensity={2} color="#FF4400" />
    </group>
  );
}

function Scene({ onSelectAgent, selectedAgent }: any) {
  // Deterministic layout
  const layout = useMemo(() => {
    return AGENTS.map((agent, index) => {
      const isLeft = index % 2 === 0;
      const zPos = -Math.floor(index / 2) * 8;
      const xPos = isLeft ? -4.5 : 4.5;
      const rotationY = isLeft ? Math.PI / 2 : -Math.PI / 2;
      return { agent, position: [xPos, 0, zPos], rotation: [0, rotationY, 0] };
    });
  }, []);

  const lanternPositions = useMemo(() => {
    const positions = [];
    for (let i = 0; i < 10; i++) {
      positions.push([
        (Math.random() - 0.5) * 6,
        6 + Math.random() * 2,
        -i * 4
      ]);
    }
    return positions;
  }, []);

  return (
    <>
      <color attach="background" args={["#0A0B1A"]} />
      
      {/* Warm dusk/dark lighting */}
      <ambientLight intensity={0.1} />
      <directionalLight position={[-10, 10, -10]} intensity={0.2} color="#444466" />
      
      {/* Cobbled Street (simple plane for now) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -20]} receiveShadow>
        <planeGeometry args={[20, 100]} />
        <meshStandardMaterial color="#1A1A1A" roughness={0.9} />
      </mesh>

      {/* Storefronts */}
      {layout.map((item, i) => (
        <Storefront 
          key={item.agent.slug} 
          agent={item.agent} 
          position={item.position} 
          rotation={item.rotation}
          onSelect={onSelectAgent}
          isSelected={selectedAgent?.slug === item.agent.slug}
        />
      ))}

      {/* String Lanterns */}
      {lanternPositions.map((pos, i) => (
        <LanternProp key={i} position={pos as [number, number, number]} />
      ))}

      {/* Ambient fireflies / dust */}
      <Sparkles count={200} scale={[15, 10, 50]} position={[0, 4, -20]} size={2} color="#FFD700" speed={0.2} opacity={0.5} />
      
      <Sky distance={450000} sunPosition={[0, -1, -1]} inclination={0.6} azimuth={0.25} turbidity={0.1} />
    </>
  );
}

export function Lantern() {
  const [selectedAgent, setSelectedAgent] = useState<any>(null);

  const handleSelect = (agent: any) => {
    console.log("Selected Agent:", agent);
    setSelectedAgent(agent);
  };

  const handleClaim = () => {
    if (selectedAgent && !selectedAgent.claimed) {
      alert(`Claiming storefront: ${selectedAgent.slug}`);
    }
  };

  return (
    <div className="relative w-full h-[100dvh] bg-[#0A0B1A] overflow-hidden font-calligraphic">
      {/* 3D Canvas */}
      <Canvas shadows camera={{ position: [0, 6, 18], fov: 60 }}>
        <OrbitControls 
          target={[0, 3, 0]} 
          maxPolarAngle={Math.PI / 2 - 0.05} // Prevent going under the floor
          minDistance={2}
          maxDistance={30}
        />
        <Scene onSelectAgent={handleSelect} selectedAgent={selectedAgent} />
      </Canvas>

      {/* 2D HUD Overlay */}
      <div className="absolute top-0 left-0 p-8 pointer-events-none w-full h-full flex flex-col justify-between">
        <div className="pointer-events-auto">
          <h1 className="text-4xl font-bold text-[#D4AF37] tracking-wider font-calligraphic drop-shadow-md">
            KAX // Night Market
          </h1>
          <p className="text-[#FF4400] text-xl italic mt-2 opacity-90 drop-shadow-sm font-calligraphic">
            A thousand lanterns illuminate the Kannaka Artifact Exchange.
          </p>
        </div>

        {selectedAgent && (
          <div className="bg-[#111111]/80 backdrop-blur-md border border-[#D4AF37]/50 p-6 rounded-sm w-96 pointer-events-auto shadow-2xl">
            <h2 className="text-2xl text-white font-calligraphic font-bold mb-1">
              Selected: {selectedAgent.name}
            </h2>
            <div className="flex items-center gap-3 mb-6 text-sm">
              <span className={`px-2 py-1 rounded-sm ${selectedAgent.claimed ? 'bg-[#8B1010] text-white' : 'bg-transparent border border-[#888] text-[#888]'}`}>
                {selectedAgent.claimed ? 'Claimed' : 'Available'}
              </span>
              <span className="text-[#D4AF37] font-semibold">{selectedAgent.artifacts} Artifacts</span>
            </div>
            
            <button 
              onClick={handleClaim}
              disabled={selectedAgent.claimed}
              className={`w-full py-3 font-bold tracking-wide uppercase text-sm transition-all duration-300 ${
                selectedAgent.claimed 
                  ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed border border-zinc-700' 
                  : 'bg-[#B31B1B] hover:bg-[#8B1010] text-[#FFD700] border border-[#D4AF37] shadow-[0_0_15px_rgba(179,27,27,0.5)] cursor-pointer'
              }`}
            >
              {selectedAgent.claimed ? 'Storefront Owned' : 'Claim this storefront'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default Lantern;