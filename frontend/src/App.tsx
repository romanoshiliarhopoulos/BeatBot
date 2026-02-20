import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import type { DeckInfo, QueueItem, TrackMeta, PlaybackStatus } from "./types";
import {
  fetchTracks,
  predictCues,
  fetchQueue,
  addToQueue,
  removeFromQueue,
  clearQueue,
} from "./api/client";
import { useAudioEngine } from "./hooks/useAudioEngine";
import type { ActiveDeck } from "./hooks/useAudioEngine";
import { useWebSocket } from "./hooks/useWebSocket";

import Deck from "./components/Deck";
import Queue from "./components/Queue";
import Transport from "./components/Transport";

// ── helpers ────────────────────────────────────────────────────────────────

const emptyDeck = (): DeckInfo => ({
  track: null,
  prediction: null,
  entry_sec: 0,
  exit_sec: 0,
});

// ── App ────────────────────────────────────────────────────────────────────

export default function App() {
  // ── server data ──────────────────────────────────────────────────────────
  const { data: library = [] } = useQuery<TrackMeta[]>({
    queryKey: ["tracks"],
    queryFn: fetchTracks,
    staleTime: 60_000,
  });

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueCursor, setQueueCursorState] = useState<number>(() => {
    try {
      return parseInt(localStorage.getItem("beatbot_cursor") ?? "0", 10) || 0;
    } catch {
      return 0;
    }
  });
  const queueCursorRef = useRef(queueCursor);
  const queueRef = useRef<QueueItem[]>([]);

  // Wrap setter so every cursor change is persisted
  const setQueueCursor = useCallback((val: number) => {
    setQueueCursorState(val);
    queueCursorRef.current = val;
    try {
      localStorage.setItem("beatbot_cursor", String(val));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    queueCursorRef.current = queueCursor;
  }, [queueCursor]);

  // ── Clamp cursor if the queue shrinks (e.g. after clear) ─────────────────
  useEffect(() => {
    if (queue.length > 0 && queueCursor >= queue.length) {
      setQueueCursor(Math.max(0, queue.length - 1));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.length]);

  // ── deck state (UI) ──────────────────────────────────────────────────────
  const [deckA, setDeckA] = useState<DeckInfo>(emptyDeck);
  const [deckB, setDeckB] = useState<DeckInfo>(emptyDeck);
  const [activeDeck, setActiveDeck] = useState<ActiveDeck>("A");
  const [deckALoading, setDeckALoading] = useState(false);
  const [deckBLoading, setDeckBLoading] = useState(false);

  // ── playback ─────────────────────────────────────────────────────────────
  const [fadeSecs, setFadeSecs] = useState(7);
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus>("idle");
  const didAutoXfade = useRef(false);

  const engine = useAudioEngine();
  const { isConnected, lastEvent } = useWebSocket();

  // ── derived ───────────────────────────────────────────────────────────────
  const nowDeck = activeDeck === "A" ? deckA : deckB;
  const nowSet = activeDeck === "A" ? setDeckA : setDeckB;
  const nextDeck = activeDeck === "A" ? deckB : deckA;
  const nextSet = activeDeck === "A" ? setDeckB : setDeckA;

  // ── Load a track into a physical deck slot ────────────────────────────────
  const loadDeckSlot = useCallback(
    async (slot: ActiveDeck, item: QueueItem, lib: TrackMeta[]) => {
      const setLoading = slot === "A" ? setDeckALoading : setDeckBLoading;
      const setSlot = slot === "A" ? setDeckA : setDeckB;

      setLoading(true);
      try {
        await engine.loadDeck(slot, item.track_id);
        const pred = await predictCues(item.track_id);
        const track = lib.find((t) => t.track_id === item.track_id) ?? null;
        setSlot({
          track,
          prediction: pred,
          entry_sec: item.entry_sec,
          exit_sec: item.exit_sec,
        });
      } catch (err) {
        console.error(`[App] loadDeckSlot ${slot}:`, err);
      } finally {
        setLoading(false);
      }
    },
    [engine],
  );

  // ── Load queue on mount ───────────────────────────────────────────────────
  useEffect(() => {
    fetchQueue().then((qs) => setQueue(qs.tracks));
  }, []);

  // ── When queue/library ready, populate empty decks ────────────────────────
  useEffect(() => {
    if (library.length === 0) return;
    const cursor = queueCursorRef.current;
    const nowItem = queue[cursor];
    const nextItem = queue[cursor + 1];
    if (nowItem && !deckA.track && !deckALoading)
      loadDeckSlot("A", nowItem, library);
    if (nextItem && !deckB.track && !deckBLoading)
      loadDeckSlot("B", nextItem, library);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, library]);

  // ── Auto-crossfade trigger ────────────────────────────────────────────────
  useEffect(() => {
    if (!engine.state.isPlaying) return;
    const active = activeDeck === "A" ? deckA : deckB;
    const inactive = activeDeck === "A" ? deckB : deckA;
    const triggerAt = active.exit_sec - fadeSecs;
    if (
      engine.state.elapsed >= triggerAt &&
      triggerAt > 0 &&
      !didAutoXfade.current
    ) {
      didAutoXfade.current = true;
      if (inactive.track) {
        setPlaybackStatus("crossfading");
        engine.crossfadeNow(inactive.entry_sec, fadeSecs);
        const newActive: ActiveDeck = activeDeck === "A" ? "B" : "A";
        setActiveDeck(newActive);
        const newCursor = queueCursorRef.current + 1;
        setQueueCursor(newCursor);
        const nextNext = queueRef.current[newCursor + 1];
        if (nextNext) loadDeckSlot(activeDeck, nextNext, library);
        else {
          if (activeDeck === "A") setDeckA(emptyDeck());
          else setDeckB(emptyDeck());
        }
        setTimeout(() => {
          setPlaybackStatus("playing");
          didAutoXfade.current = false;
        }, fadeSecs * 1000);
      } else {
        didAutoXfade.current = false;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.state.elapsed, engine.state.isPlaying]);

  // ── WebSocket events ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!lastEvent) return;
    if (lastEvent.type === "queue.updated") {
      setQueue(lastEvent.tracks);
    } else if (lastEvent.type === "cues.accepted") {
      const { track_id, cue_type, accepted_sec } = lastEvent;
      const update = (d: DeckInfo): DeckInfo => {
        if (!d.track || d.track.track_id !== track_id) return d;
        return {
          ...d,
          entry_sec: cue_type === "entry" ? accepted_sec : d.entry_sec,
          exit_sec: cue_type === "exit" ? accepted_sec : d.exit_sec,
        };
      };
      setDeckA(update);
      setDeckB(update);
    }
  }, [lastEvent]);

  // ── Transport handlers ────────────────────────────────────────────────────
  const handlePlay = useCallback(async () => {
    await engine.resume();
    if (nowDeck.track) {
      setPlaybackStatus("playing");
      engine.play(nowDeck.entry_sec, nowDeck.exit_sec, fadeSecs);
      didAutoXfade.current = false;
    }
  }, [engine, nowDeck, fadeSecs]);

  const handleStop = useCallback(() => {
    engine.stop();
    setPlaybackStatus("idle");
    didAutoXfade.current = false;
  }, [engine]);

  const handleMixNow = useCallback(() => {
    if (!nextDeck.track) return;
    setPlaybackStatus("crossfading");
    engine.crossfadeNow(nextDeck.entry_sec, fadeSecs);
    const newActive: ActiveDeck = activeDeck === "A" ? "B" : "A";
    setActiveDeck(newActive);
    const newCursor = queueCursorRef.current + 1;
    setQueueCursor(newCursor);
    const nextNext = queueRef.current[newCursor + 1];
    if (nextNext) loadDeckSlot(activeDeck, nextNext, library);
    else {
      if (activeDeck === "A") setDeckA(emptyDeck());
      else setDeckB(emptyDeck());
    }
    didAutoXfade.current = false;
    setTimeout(() => setPlaybackStatus("playing"), fadeSecs * 1000);
  }, [engine, nextDeck, activeDeck, fadeSecs, library, loadDeckSlot]);

  // ── Queue handlers ────────────────────────────────────────────────────────
  const handleAdd = useCallback(async (trackId: string) => {
    const qs = await addToQueue([trackId]);
    setQueue(qs.tracks);
  }, []);

  const handleRemove = useCallback(async (position: number) => {
    const qs = await removeFromQueue(position);
    setQueue(qs.tracks);
  }, []);

  // Skip the UP NEXT track: remove it from the queue and load whatever comes after
  const handleSkipNext = useCallback(async () => {
    const nextPosition = queueCursorRef.current + 1;
    if (nextPosition >= queueRef.current.length) return; // nothing to skip
    const qs = await removeFromQueue(nextPosition);
    setQueue(qs.tracks);
    // Clear the next deck slot; the queue-watch effect will reload from the new position
    if (activeDeck === "A") setDeckB(emptyDeck());
    else setDeckA(emptyDeck());
  }, [activeDeck]);

  const handleClear = useCallback(async () => {
    const qs = await clearQueue();
    setQueue(qs.tracks);
    setQueueCursor(0);
    setDeckA(emptyDeck());
    setDeckB(emptyDeck());
  }, []);

  const handleShuffle = useCallback(async (subset: TrackMeta[]) => {
    // Clear then add shuffled subset
    await clearQueue();
    setQueueCursor(0);
    setDeckA(emptyDeck());
    setDeckB(emptyDeck());
    const shuffled = [...subset].sort(() => Math.random() - 0.5);
    const qs = await addToQueue(shuffled.map((t) => t.track_id));
    setQueue(qs.tracks);
  }, []);

  // ── Cue edit callbacks ────────────────────────────────────────────────────
  const handleNowCueUpdate = useCallback(
    (type: "entry" | "exit", sec: number) => {
      nowSet((d) => ({
        ...d,
        entry_sec: type === "entry" ? sec : d.entry_sec,
        exit_sec: type === "exit" ? sec : d.exit_sec,
      }));
    },
    [nowSet],
  );

  const handleNextCueUpdate = useCallback(
    (type: "entry" | "exit", sec: number) => {
      nextSet((d) => ({
        ...d,
        entry_sec: type === "entry" ? sec : d.entry_sec,
        exit_sec: type === "exit" ? sec : d.exit_sec,
      }));
    },
    [nextSet],
  );

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.code === "Space") {
        e.preventDefault();
        if (!engine.state.isPlaying) handlePlay();
        else if (nextDeck.track) handleMixNow();
      }
      if (e.code === "Escape") handleStop();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    engine.state.isPlaying,
    handlePlay,
    handleMixNow,
    handleStop,
    nextDeck.track,
  ]);

  // ── Sync status with engine state ─────────────────────────────────────────
  useEffect(() => {
    if (!engine.state.isPlaying && playbackStatus === "playing")
      setPlaybackStatus("idle");
  }, [engine.state.isPlaying]);

  // ── Render ─────────────────────────────────────────────────────────────────
  const nowLoading = activeDeck === "A" ? deckALoading : deckBLoading;
  const nextLoading = activeDeck === "A" ? deckBLoading : deckALoading;

  return (
    <div className="flex flex-col h-screen bg-[#07070f] text-white select-none">
      {/* Header */}
      <header className="flex items-center gap-3 px-6 py-3 border-b border-white/5 shrink-0">
        <span className="text-purple-400 text-lg font-bold tracking-tight">
          Beat<span className="text-white">Bot</span>
        </span>
        <span className="text-gray-700 text-[10px] uppercase tracking-widest">
          AI DJ
        </span>
        <div className="ml-auto flex items-center gap-4 text-xs text-gray-600">
          <span>{library.length} tracks</span>
          <span>{queue.length} in queue</span>
        </div>
      </header>

      {/* Decks + Queue */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* NOW PLAYING deck */}
        <div className="flex flex-col flex-1 p-3 min-w-0 min-h-0">
          <Deck
            role="NOW PLAYING"
            deck={nowDeck}
            elapsed={engine.state.elapsed}
            isLoading={nowLoading}
            onCueUpdate={handleNowCueUpdate}
          />
        </div>

        {/* UP NEXT deck */}
        <div className="flex flex-col flex-1 p-3 min-w-0 min-h-0 border-l border-white/5">
          <Deck
            role="UP NEXT"
            deck={nextDeck}
            isLoading={nextLoading}
            onCueUpdate={handleNextCueUpdate}
            onSkip={handleSkipNext}
          />
        </div>

        {/* Queue sidebar */}
        <div className="flex flex-col w-80 shrink-0 p-3 min-h-0 border-l border-white/5">
          <Queue
            queue={queue}
            currentIndex={queueCursor}
            library={library}
            onAdd={handleAdd}
            onRemove={handleRemove}
            onClear={handleClear}
            onShuffle={handleShuffle}
          />
        </div>
      </div>

      {/* Transport */}
      <div className="shrink-0">
        <Transport
          status={playbackStatus}
          isConnected={isConnected}
          onPlay={handlePlay}
          onStop={handleStop}
          onMixNow={handleMixNow}
          fadeSecs={fadeSecs}
          onFadeChange={setFadeSecs}
          currentTrack={nowDeck.track?.track_id ?? null}
          nextTrack={nextDeck.track?.track_id ?? null}
          elapsed={engine.state.elapsed}
          exitSec={nowDeck.exit_sec}
        />
      </div>
    </div>
  );
}
