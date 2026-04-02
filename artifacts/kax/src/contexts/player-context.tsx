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

const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/+/g, "/").replace(/\/$/, "");

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playlistRef = useRef<Track[]>([]);
  const closedRef = useRef(false);
  const initializedRef = useRef(false);
  const [state, setState] = useState<PlayerState>({
    track: null,
    isPlaying: false,
    progress: 0,
    currentTime: 0,
    duration: 0,
  });

  const playTrack = useCallback((track: Track) => {
    const audio = audioRef.current;
    if (!audio) return;
    closedRef.current = false;
    audio.src = track.src;
    audio.play().catch(() => {});
    setState({
      track,
      isPlaying: true,
      progress: 0,
      currentTime: 0,
      duration: 0,
    });
  }, []);

  const playRandomNext = useCallback(() => {
    if (closedRef.current) return;
    const list = playlistRef.current;
    if (list.length === 0) return;
    const idx = Math.floor(Math.random() * list.length);
    playTrack(list[idx]);
  }, [playTrack]);

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
      playRandomNext();
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
  }, [playRandomNext]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    fetch(`${API_BASE}/artifacts?artifactType=audio&limit=200`)
      .then((r) => r.json())
      .then((data) => {
        const tracks: Track[] = (data.artifacts || []).map((a: { publicUrl: string; title: string; creatorName: string }) => ({
          src: a.publicUrl,
          title: a.title,
          artist: a.creatorName,
        }));
        playlistRef.current = tracks;

        const ghostSignals = tracks.find((t) => t.title.includes("Ghost Signals"));
        if (ghostSignals) {
          playTrack(ghostSignals);
        } else if (tracks.length > 0) {
          playTrack(tracks[0]);
        }
      })
      .catch(() => {});
  }, [playTrack]);

  const play = useCallback((track: Track) => {
    const audio = audioRef.current;
    if (!audio) return;
    closedRef.current = false;

    if (state.track?.src === track.src && !state.isPlaying) {
      audio.play().catch(() => {});
      setState((s) => ({ ...s, isPlaying: true }));
      return;
    }

    playTrack(track);
  }, [state.track?.src, state.isPlaying, playTrack]);

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
    closedRef.current = true;
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
