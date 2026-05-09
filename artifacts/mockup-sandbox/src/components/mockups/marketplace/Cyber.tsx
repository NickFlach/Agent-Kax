import React, { useState, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Text, MeshReflectorMaterial, Sparkles } from '@react-three/drei';
import * as THREE from 'three';
import './_group.css';

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

function Storefront({ 
  agent, 
  position, 
  rotation, 
  onClick 
}: { 
  agent: typeof AGENTS[0], 
  position: [number, number, number], 
  rotation: [number, number, number],
  onClick: (agent: typeof AGENTS[0]) => void 
}) {
  const isClaimed = agent.claimed;
  const mainColor = isClaimed ? '#ff1493' : '#00ffff'; 
  const signRef = useRef<THREE.Mesh>(null);
  const glyphRef = useRef<THREE.Group>(null);

  useFrame((state) => {
    // Flicker effect for sign
    if (signRef.current && signRef.current.material) {
      const mat = signRef.current.material as THREE.MeshStandardMaterial;
      mat.opacity = 0.7 + Math.random() * 0.3;
      mat.emissiveIntensity = 1 + Math.random() * 0.5;
    }
    
    // Float/flicker the glyphs
    if (glyphRef.current) {
      glyphRef.current.position.y = 5.5 + Math.sin(state.clock.elapsedTime * 2 + position[2]) * 0.2;
    }
  });

  return (
    <group position={position} rotation={rotation}>
      {/* Building Base / Stacked blocks */}
      <mesh position={[0, 2, 0]}>
        <boxGeometry args={[3, 4, 3]} />
        <meshStandardMaterial color="#05000a" roughness={0.7} metalness={0.2} />
      </mesh>
      <mesh position={[0, 4.5, 0.2]}>
        <boxGeometry args={[2.8, 1, 2.8]} />
        <meshStandardMaterial color="#0a0514" roughness={0.8} />
      </mesh>
      <mesh position={[0, 5.5, 0.4]}>
        <boxGeometry args={[2.2, 1, 2.2]} />
        <meshStandardMaterial color="#030105" roughness={0.9} />
      </mesh>
      
      {/* Door/Entrance indicator */}
      <mesh position={[0, 1, 1.51]}>
        <planeGeometry args={[1, 2]} />
        <meshStandardMaterial color={isClaimed ? "#2a001a" : "#001a1a"} emissive={mainColor} emissiveIntensity={0.2} />
      </mesh>

      {/* Main Signage */}
      <mesh 
        position={[0, 3, 1.6]} 
        ref={signRef} 
        onClick={(e) => { e.stopPropagation(); onClick(agent); }} 
        onPointerOver={() => document.body.style.cursor='pointer'} 
        onPointerOut={() => document.body.style.cursor='auto'}
      >
        <boxGeometry args={[2.8, 1, 0.1]} />
        <meshStandardMaterial 
          color={mainColor} 
          emissive={mainColor} 
          emissiveIntensity={1.5} 
          transparent 
          opacity={0.9} 
        />
      </mesh>
      
      {/* Agent Name */}
      <Text 
        position={[0, 3.1, 1.66]} 
        fontSize={0.35} 
        color="#ffffff" 
        font="https://fonts.gstatic.com/s/spacemono/v12/i7dPIFZifjKcF5UAWdDRYEF8RQ.woff" 
        anchorX="center" 
        anchorY="middle"
      >
        {agent.name}
      </Text>

      {/* Artifact Count */}
      <Text 
        position={[0, 2.7, 1.66]} 
        fontSize={0.15} 
        color="#e0e0e0" 
        font="https://fonts.gstatic.com/s/spacemono/v12/i7dPIFZifjKcF5UAWdDRYEF8RQ.woff"
      >
        {agent.artifacts} ARTIFACTS
      </Text>

      {/* Unclaimed Status */}
      {!isClaimed && (
        <Text 
          position={[0, 3.8, 1.66]} 
          fontSize={0.15} 
          color="#00ffff" 
          font="https://fonts.gstatic.com/s/spacemono/v12/i7dPIFZifjKcF5UAWdDRYEF8RQ.woff"
        >
          [ AVAILABLE ]
        </Text>
      )}

      {/* Floating Holographic Glyphs */}
      <group ref={glyphRef} position={[0, 5.5, 1.2]}>
        <Text 
          position={[0, 0, 0]} 
          fontSize={0.8} 
          color={isClaimed ? "#ff1493" : "#39ff14"} 
          font="https://fonts.gstatic.com/s/spacemono/v12/i7dPIFZifjKcF5UAWdDRYEF8RQ.woff"
          fillOpacity={0.6}
        >
          {agent.name.substring(0, 2).toUpperCase()}
        </Text>
      </group>
    </group>
  );
}

export function Cyber() {
  const [selectedAgent, setSelectedAgent] = useState<typeof AGENTS[0] | null>(null);

  const layout = useMemo(() => {
    return AGENTS.map((agent, i) => {
      const isLeft = i % 2 === 0;
      // Staggered z positions
      const row = Math.floor(i / 2);
      const z = -2 - row * 4.5 + (i % 3 === 0 ? 0.5 : 0);
      const x = isLeft ? -4.5 : 4.5;
      const rotation = isLeft ? [0, Math.PI / 2, 0] : [0, -Math.PI / 2, 0];
      return { 
        agent, 
        position: [x, 0, z] as [number, number, number], 
        rotation: rotation as [number, number, number] 
      };
    });
  }, []);

  const handleClaim = () => {
    if (selectedAgent && !selectedAgent.claimed) {
      alert(`Claiming storefront for: ${selectedAgent.slug}`);
    }
  };

  return (
    <div className="relative min-h-screen w-full bg-black overflow-hidden font-cyber">
      {/* 2D HUD Overlay */}
      <div className="absolute top-0 left-0 p-6 z-10 pointer-events-none w-full flex justify-between items-start">
        <div className="cyber-hud p-4 rounded-sm pointer-events-auto max-w-sm">
          <h1 className="text-2xl font-bold text-white text-glow-pink mb-1">KAX // NEON DISTRICT</h1>
          <p className="text-sm text-cyan-300 text-glow-cyan mb-4 uppercase tracking-widest">
            Sector 4 // Rain Protocol Active
          </p>
          
          <div className="border-t border-pink-500/30 pt-4 mt-2">
            {selectedAgent ? (
              <div className="flex flex-col gap-3">
                <div>
                  <div className="text-xs text-pink-400 mb-1">TARGET ACQUIRED</div>
                  <div className="text-lg text-white">ID: {selectedAgent.name}</div>
                  <div className="text-sm text-gray-400">Inventory: {selectedAgent.artifacts}</div>
                  <div className="text-sm text-gray-400">Status: {selectedAgent.claimed ? 'SECURED' : 'AVAILABLE'}</div>
                </div>
                
                <button 
                  onClick={handleClaim}
                  disabled={selectedAgent.claimed}
                  className={`px-4 py-2 mt-2 text-sm uppercase tracking-wider font-bold transition-all border
                    ${selectedAgent.claimed 
                      ? 'bg-gray-800/50 border-gray-600 text-gray-500 cursor-not-allowed' 
                      : 'bg-cyan-900/40 border-cyan-400 text-cyan-300 hover:bg-cyan-800/60 hover:text-white text-glow-cyan'
                    }`}
                >
                  {selectedAgent.claimed ? 'ACCESS DENIED' : 'INITIATE CLAIM'}
                </button>
              </div>
            ) : (
              <div className="text-sm text-gray-500 italic animate-pulse">
                &gt; SCANNING FOR ENTITIES...
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 3D Scene */}
      <Canvas camera={{ position: [0, 6, 18], fov: 45 }}>
        <color attach="background" args={['#020005']} />
        <fog attach="fog" args={['#020005', 10, 45]} />
        
        <ambientLight intensity={0.2} color="#4a0080" />
        <directionalLight position={[0, 10, 5]} intensity={0.5} color="#00ffff" />
        <pointLight position={[10, 10, -10]} intensity={1} color="#ff1493" />
        
        <OrbitControls 
          target={[0, 2, -10]} 
          maxPolarAngle={Math.PI / 2 - 0.05} // Prevent looking below ground
          minDistance={2}
          maxDistance={30}
        />

        {/* Glossy Wet Street */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
          <planeGeometry args={[100, 200]} />
          <MeshReflectorMaterial
            blur={[400, 100]}
            resolution={1024}
            mixBlur={1}
            mixStrength={80}
            roughness={1}
            depthScale={1.2}
            minDepthThreshold={0.4}
            maxDepthThreshold={1.4}
            color="#050505"
            metalness={0.8}
            mirror={0.6}
          />
        </mesh>

        {/* Ambient Particles (Rain/Sparks) */}
        <Sparkles count={500} scale={[20, 10, 40]} size={1.5} speed={0.4} opacity={0.2} color="#00ffff" position={[0, 5, -10]} />
        <Sparkles count={300} scale={[20, 10, 40]} size={2} speed={0.6} opacity={0.3} color="#ff1493" position={[0, 5, -10]} />

        {/* Storefronts */}
        {layout.map((item) => (
          <Storefront 
            key={item.agent.slug} 
            agent={item.agent} 
            position={item.position} 
            rotation={item.rotation}
            onClick={(agent) => {
              console.log("Selected agent:", agent);
              setSelectedAgent(agent);
            }}
          />
        ))}
      </Canvas>
    </div>
  );
}

export default Cyber;
