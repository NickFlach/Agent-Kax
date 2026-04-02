import { usePlayer } from "@/contexts/player-context";

interface AudioPlayerProps {
  src: string;
  title: string;
  artist?: string;
  compact?: boolean;
}

export function AudioPlayer({ src, title, artist, compact = false }: AudioPlayerProps) {
  const { track, isPlaying, progress, currentTime, duration, play, togglePlay, seek } = usePlayer();

  const isThisTrack = track?.src === src;
  const isThisPlaying = isThisTrack && isPlaying;
  const displayProgress = isThisTrack ? progress : 0;
  const displayTime = isThisTrack ? currentTime : 0;
  const displayDuration = isThisTrack ? duration : 0;

  const handleToggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isThisTrack) {
      togglePlay();
    } else {
      play({ src, title, artist });
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isThisTrack) {
      play({ src, title, artist });
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    seek(Math.max(0, Math.min(1, pct)));
  };

  const fmt = (s: number) => {
    if (!s || !isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  if (compact) {
    return (
      <div className="flex items-center gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={handleToggle}
          className="w-8 h-8 flex items-center justify-center bg-primary/20 hover:bg-primary/30 transition-colors flex-shrink-0"
        >
          {isThisPlaying ? (
            <svg viewBox="0 0 24 24" className="w-4 h-4 text-primary" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="w-4 h-4 text-primary" fill="currentColor">
              <polygon points="5,3 19,12 5,21" />
            </svg>
          )}
        </button>
        <div className="flex-1 h-1 bg-border cursor-pointer" onClick={handleSeek}>
          <div className="h-full bg-primary transition-all" style={{ width: `${displayProgress}%` }} />
        </div>
        <span className="text-[10px] font-mono text-muted-foreground flex-shrink-0">{fmt(displayTime)}</span>
      </div>
    );
  }

  return (
    <div className="bg-black/40 backdrop-blur-sm p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-3">
        <button
          onClick={handleToggle}
          className="w-12 h-12 flex items-center justify-center border border-primary/40 hover:bg-primary/20 transition-colors flex-shrink-0"
        >
          {isThisPlaying ? (
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
          <p className="text-sm font-medium truncate">{title}</p>
          <div className="flex items-center gap-2 mt-1">
            <div className="flex-1 h-1.5 bg-border cursor-pointer" onClick={handleSeek}>
              <div className="h-full bg-primary transition-all" style={{ width: `${displayProgress}%` }} />
            </div>
            <span className="text-xs font-mono text-muted-foreground flex-shrink-0">
              {fmt(displayTime)} / {fmt(displayDuration)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
