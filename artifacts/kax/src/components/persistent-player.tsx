import { usePlayer } from "@/contexts/player-context";

const fmt = (s: number) => {
  if (!s || !isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

export function PersistentPlayer() {
  const { track, isPlaying, progress, currentTime, duration, togglePlay, seek, close } = usePlayer();

  if (!track) return null;

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    seek(Math.max(0, Math.min(1, pct)));
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 z-[100] border-t border-primary/30 bg-background/95 backdrop-blur-md">
      <div className="h-0.5 bg-border">
        <div className="h-full bg-primary transition-all duration-200" style={{ width: `${progress}%` }} />
      </div>

      <div className="max-w-7xl mx-auto px-4 py-2 flex items-center gap-4">
        <button
          onClick={togglePlay}
          className="w-10 h-10 flex items-center justify-center border border-primary/40 hover:bg-primary/20 transition-colors flex-shrink-0"
          data-testid="persistent-player-toggle"
        >
          {isPlaying ? (
            <svg viewBox="0 0 24 24" className="w-5 h-5 text-primary" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="w-5 h-5 text-primary" fill="currentColor">
              <polygon points="5,3 19,12 5,21" />
            </svg>
          )}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-shrink">
              <p className="text-sm font-medium truncate" data-testid="persistent-player-title">{track.title}</p>
              {track.artist && (
                <p className="text-[10px] text-muted-foreground truncate">{track.artist}</p>
              )}
            </div>
            <div className="flex-1 flex items-center gap-2">
              <span className="text-[10px] font-mono text-muted-foreground flex-shrink-0">{fmt(currentTime)}</span>
              <div className="flex-1 h-1.5 bg-border cursor-pointer group" onClick={handleSeek}>
                <div className="h-full bg-primary/70 group-hover:bg-primary transition-all" style={{ width: `${progress}%` }} />
              </div>
              <span className="text-[10px] font-mono text-muted-foreground flex-shrink-0">{fmt(duration)}</span>
            </div>
          </div>
        </div>

        <button
          onClick={close}
          className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
          data-testid="persistent-player-close"
        >
          <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
