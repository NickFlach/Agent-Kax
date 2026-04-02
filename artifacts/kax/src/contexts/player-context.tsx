import { createContext, useContext, useState, useRef, useEffect, useCallback } from "react";

interface Track {
  src: string;
  title: string;
  artist?: string;
}

interface PlayerState {
  track: Track | null;
  isPlaying: boolean;
  progress: number;
  currentTime: number;
  duration: number;
}

interface PlayerContextValue extends PlayerState {
  play: (track: Track) => void;
  pause: () => void;
  resume: () => void;
  togglePlay: () => void;
  seek: (pct: number) => void;
  close: () => void;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer must be used within PlayerProvider");
  return ctx;
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<PlayerState>({
    track: null,
    isPlaying: false,
    progress: 0,
    currentTime: 0,
    duration: 0,
  });

  useEffect(() => {
    const audio = new Audio();
    audio.preload = "metadata";
    audioRef.current = audio;

    const onTimeUpdate = () => {
      setState((s) => ({
        ...s,
        currentTime: audio.currentTime,
        progress: audio.duration ? (audio.currentTime / audio.duration) * 100 : 0,
      }));
    };
    const onLoadedMetadata = () => {
      setState((s) => ({ ...s, duration: audio.duration }));
    };
    const onEnded = () => {
      setState((s) => ({ ...s, isPlaying: false }));
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("ended", onEnded);
      audio.pause();
    };
  }, []);

  const play = useCallback((track: Track) => {
    const audio = audioRef.current;
    if (!audio) return;

    if (state.track?.src === track.src && !state.isPlaying) {
      audio.play().catch(() => {});
      setState((s) => ({ ...s, isPlaying: true }));
      return;
    }

    audio.src = track.src;
    audio.play().catch(() => {});
    setState({
      track,
      isPlaying: true,
      progress: 0,
      currentTime: 0,
      duration: 0,
    });
  }, [state.track?.src, state.isPlaying]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setState((s) => ({ ...s, isPlaying: false }));
  }, []);

  const resume = useCallback(() => {
    audioRef.current?.play().catch(() => {});
    setState((s) => ({ ...s, isPlaying: true }));
  }, []);

  const togglePlay = useCallback(() => {
    if (state.isPlaying) {
      pause();
    } else {
      resume();
    }
  }, [state.isPlaying, pause, resume]);

  const seek = useCallback((pct: number) => {
    const audio = audioRef.current;
    if (!audio || !audio.duration) return;
    audio.currentTime = pct * audio.duration;
  }, []);

  const close = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
    }
    setState({
      track: null,
      isPlaying: false,
      progress: 0,
      currentTime: 0,
      duration: 0,
    });
  }, []);

  return (
    <PlayerContext.Provider value={{ ...state, play, pause, resume, togglePlay, seek, close }}>
      {children}
    </PlayerContext.Provider>
  );
}
