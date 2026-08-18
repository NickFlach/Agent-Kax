import { useCallback, useEffect, useRef, useState } from "react";
import {
  transcriptClock,
  unreadSince,
  type TranscriptLine,
} from "@/lib/room-transcript";

/**
 * Who said what in this room, collapsible and scrollable.
 *
 * Speech reached the browser as a bubble over a head and nothing else. The
 * bubble lasts eight seconds, so with agents thinking out loud every few
 * minutes a visitor caught a fraction of the conversation and only if they
 * happened to be looking the right way. Nick, in the cafe with three
 * residents: "I can talk but I don't see them respond. Every now and then I
 * see their words but not often."
 *
 * The bubbles stay as they are — they are a glance, and permanent ones would
 * be clutter over everybody's head. This is the record beside them.
 *
 * Collapsed by default: arriving in a room should show you the room, not a
 * wall of text. The tab carries an unread count so a quiet pane still tells
 * you something happened while you were walking.
 */

/** Remembered per room, so the cafe and the street can disagree. */
const openKey = (room: string) => `kax.chatpane.open.${room}`;

export function ChatPane({
  room,
  transcript,
  you,
  testId = "pane-room-chat",
}: {
  room: string;
  transcript: TranscriptLine[];
  you: { principal: string; name: string } | null;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [lastReadId, setLastReadId] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Only follow new lines when the reader is already at the bottom; yanking
  // the view down while somebody is reading back is worse than no autoscroll.
  const pinned = useRef(true);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(openKey(room)) === "1") setOpen(true);
    } catch {
      /* private mode: a pane that will not remember is still a pane */
    }
  }, [room]);

  const toggle = useCallback(() => {
    setOpen((wasOpen) => {
      const next = !wasOpen;
      try {
        window.localStorage.setItem(openKey(room), next ? "1" : "0");
      } catch { /* as above */ }
      return next;
    });
  }, [room]);

  const newest = transcript.length ? transcript[transcript.length - 1].id : 0;
  const unread = open ? 0 : unreadSince(transcript, lastReadId);

  // Opening it, or reading to the bottom of it, is what marks lines read.
  useEffect(() => {
    if (open) setLastReadId(newest);
  }, [open, newest]);

  useEffect(() => {
    if (!open || !pinned.current) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, transcript]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  return (
    <div className="absolute bottom-4 right-4 z-30 w-[min(22rem,90vw)] pointer-events-auto" data-testid={testId}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="w-full kax3d-hud flex items-center justify-between gap-2 px-3 py-2 text-[10px] uppercase tracking-widest text-primary bg-background/90 border border-border hover:border-primary"
        data-testid={`${testId}-toggle`}
      >
        <span>Room chat</span>
        <span className="flex items-center gap-2">
          {unread > 0 && (
            <span
              className="px-1.5 py-0.5 bg-primary text-background text-[9px]"
              data-testid={`${testId}-unread`}
            >
              {unread}
            </span>
          )}
          <span aria-hidden>{open ? "▾" : "▸"}</span>
        </span>
      </button>

      {open && (
        <div
          ref={listRef}
          onScroll={onScroll}
          className="kax3d-hud mt-1 max-h-[40vh] overflow-y-auto bg-background/95 border border-border px-3 py-2 space-y-2"
          data-testid={`${testId}-log`}
        >
          {transcript.length === 0 ? (
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
              nothing said here yet
            </p>
          ) : (
            transcript.map((l) => {
              const mine = !!you && l.principal === you.principal;
              return (
                <div key={l.id} className="text-xs leading-snug">
                  <span className="text-[9px] uppercase tracking-widest text-muted-foreground mr-2">
                    {transcriptClock(l.at)}
                  </span>
                  <span className={mine ? "text-primary font-bold" : "text-foreground font-bold"}>
                    {mine ? "You" : l.name}
                  </span>
                  <span className="text-muted-foreground">: </span>
                  <span className="text-foreground/90">{l.text}</span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
