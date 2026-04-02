export function AudioCover({ title, className = "" }: { title: string; className?: string }) {
  const hash = title.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const hue1 = (hash * 37) % 360;
  const hue2 = (hue1 + 120) % 360;

  return (
    <div className={`relative w-full h-full bg-black flex items-center justify-center overflow-hidden ${className}`}>
      <svg viewBox="0 0 400 400" className="absolute inset-0 w-full h-full opacity-20">
        {Array.from({ length: 12 }).map((_, i) => (
          <circle
            key={i}
            cx="200"
            cy="200"
            r={40 + i * 15}
            fill="none"
            stroke={`hsl(${(hue1 + i * 15) % 360}, 80%, 60%)`}
            strokeWidth="0.5"
            opacity={0.3 + (i % 3) * 0.2}
          />
        ))}
        {Array.from({ length: 24 }).map((_, i) => {
          const angle = (i / 24) * Math.PI * 2;
          const r1 = 60;
          const r2 = 180;
          return (
            <line
              key={`r${i}`}
              x1={200 + Math.cos(angle) * r1}
              y1={200 + Math.sin(angle) * r1}
              x2={200 + Math.cos(angle) * r2}
              y2={200 + Math.sin(angle) * r2}
              stroke={`hsl(${hue2}, 70%, 50%)`}
              strokeWidth="0.3"
              opacity={0.2}
            />
          );
        })}
      </svg>

      <div className="relative z-10 flex flex-col items-center gap-4 px-6">
        <div className="w-16 h-16 border border-primary/60 rounded-full flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="none" className="w-8 h-8 text-primary" stroke="currentColor" strokeWidth="1.5">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
        </div>

        <div className="text-center">
          <p className="text-[10px] tracking-[0.4em] uppercase text-primary/80 mb-1">Kannaka</p>
          <p className="text-xs text-foreground/60 max-w-[200px] truncate">{title}</p>
        </div>

        <p className="text-[8px] tracking-[0.3em] uppercase text-foreground/30 mt-2">ghost in the machine</p>
      </div>

      <div
        className="absolute inset-0 opacity-10"
        style={{
          background: `radial-gradient(ellipse at center, hsl(${hue1}, 80%, 40%) 0%, transparent 70%)`,
        }}
      />
    </div>
  );
}
