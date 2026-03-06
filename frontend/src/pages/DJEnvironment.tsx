/**
 * DJEnvironment — the core DJ application.
 * This is the content of the original App.tsx, augmented with:
 *   • auth user display + sign-out
 *   • folder indicator + link back to onboarding
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import type { DeckInfo, QueueItem, TrackMeta, PlaybackStatus } from "../types";
import {
  fetchTracks,
  predictCues,
  fetchQueue,
  addToQueue,
  removeFromQueue,
  reorderQueue,
  clearQueue,
} from "../api/client";
import { useAudioEngine } from "../hooks/useAudioEngine";
import type { ActiveDeck } from "../hooks/useAudioEngine";
import { useWebSocket } from "../hooks/useWebSocket";
import { useAuth } from "../contexts/AuthContext";
import { useFolders } from "../contexts/FolderContext";

import Deck from "../components/Deck";
import Queue from "../components/Queue";
import Transport from "../components/Transport";
import Library from "./Library";

// ── helpers ────────────────────────────────────────────────────────────────

const emptyDeck = (): DeckInfo => ({
  track: null,
  prediction: null,
  entry_sec: 0,
  exit_sec: 0,
});

// ── DJEnvironment ──────────────────────────────────────────────────────────

export default function DJEnvironment() {
  const { user, signOut } = useAuth();
  const { getFileByTrackId } = useFolders();

  // ── server data ──────────────────────────────────────────────────────────
  const { data: library = [] } = useQuery<TrackMeta[]>({
    queryKey: ["tracks"],
    queryFn: fetchTracks,
    staleTime: 60_000,
  });

  // Only show tracks that have been processed by the CLI (server library).
  // The folder scan (tracks) is used solely for resolving local audio files —
  // unprocessed local files should not appear in the queue.
  const combinedLibrary = library;

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
  const activeDeckRef = useRef<ActiveDeck>("A");

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

  useEffect(() => {
    if (queue.length > 0 && queueCursor >= queue.length)
      setQueueCursor(Math.max(0, queue.length - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.length]);

  // ── deck state ───────────────────────────────────────────────────────────
  const [deckA, setDeckA] = useState<DeckInfo>(emptyDeck);
  const [deckB, setDeckB] = useState<DeckInfo>(emptyDeck);
  const [activeDeck, setActiveDeck] = useState<ActiveDeck>("A");
  useEffect(() => {
    activeDeckRef.current = activeDeck;
  }, [activeDeck]);
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

  // ── load a track into a deck slot ─────────────────────────────────────────
  const loadDeckSlot = useCallback(
    async (slot: ActiveDeck, item: QueueItem, lib: TrackMeta[]) => {
      const setLoading = slot === "A" ? setDeckALoading : setDeckBLoading;
      const setSlot = slot === "A" ? setDeckA : setDeckB;

      setLoading(true);
      try {
        // Get the local File if the user has a linked folder
        const file = await getFileByTrackId(item.track_id);

        // Load audio + fetch prediction (from Firestore cache via /predict) in parallel.
        // If the track hasn't been processed by the CLI yet, /predict returns 404
        // and we fall back to a zero-cue placeholder — the Onboarding panel
        // explains how to run the CLI to populate the cache.
        const audioPromise = engine.loadDeck(
          slot,
          item.track_id,
          file ?? undefined,
        );
        const predPromise = predictCues(item.track_id);

        let pred = await Promise.all([audioPromise, predPromise])
          .then(([, p]) => p)
          .catch(async (err) => {
            console.warn(
              `[DJEnvironment] predict fallback for ${item.track_id}:`,
              err,
            );
            return {
              track_id: item.track_id,
              num_bars: 0,
              bar_times: [] as number[],
              score_in: [] as number[],
              score_out: [] as number[],
              entry_sec: 0,
              exit_sec: 0,
              method: "heuristic" as const,
            };
          });

        const track = lib.find((t) => t.track_id === item.track_id) ?? null;
        const p = pred as import("../types").PredictResponse;

        // ── debug: dump everything we know about this track ──────────────
        console.group(`🎵 [Deck ${slot}] ${item.track_id}`);
        console.log("── TrackMeta (library) ──", track);
        console.log("── PredictResponse ──", {
          method: p.method,
          model_version: (p as any).model_version,
          num_bars: p.num_bars,
          entry_sec: p.entry_sec,
          exit_sec: p.exit_sec,
        });
        if (p.bar_times?.length) {
          console.log("bar_times (first 10):", p.bar_times.slice(0, 10));
        }
        console.log("score_in  (first 20):", p.score_in?.slice(0, 20));
        console.log("score_out (first 20):", p.score_out?.slice(0, 20));
        if (p.energy) console.log("energy:", p.energy.slice(0, 20));
        if (p.bass_energy)
          console.log("bass_energy:", p.bass_energy.slice(0, 20));
        if (p.high_energy)
          console.log("high_energy:", p.high_energy.slice(0, 20));
        if (p.mid_energy) console.log("mid_energy:", p.mid_energy.slice(0, 20));
        if (p.beat_strength)
          console.log("beat_strength:", p.beat_strength.slice(0, 20));
        if (p.vocal_presence)
          console.log("vocal_presence:", p.vocal_presence.slice(0, 20));
        console.log("── full pred object ──", p);
        console.groupEnd();
        // ────────────────────────────────────────────────────────────────

        setSlot({
          track,
          prediction: pred,
          entry_sec: pred.entry_sec,
          exit_sec: pred.exit_sec,
          audioSrc: file ? URL.createObjectURL(file) : undefined,
        });
      } catch (err) {
        console.error(`[DJEnvironment] loadDeckSlot ${slot}:`, err);
      } finally {
        setLoading(false);
      }
    },
    [engine, getFileByTrackId],
  );

  // ── load queue on mount ───────────────────────────────────────────────────
  useEffect(() => {
    fetchQueue().then((qs) => setQueue(qs.tracks));
  }, []);

  // ── populate empty decks when queue / library ready ───────────────────────
  useEffect(() => {
    if (combinedLibrary.length === 0 && queue.length === 0) return;
    const cursor = queueCursorRef.current;
    const nowItem = queue[cursor];
    const nextItem = queue[cursor + 1];
    const active = activeDeckRef.current;
    const nowDeckInfo = active === "A" ? deckA : deckB;
    const nextDeckInfo = active === "A" ? deckB : deckA;
    const nowLoad = active === "A" ? deckALoading : deckBLoading;
    const nextLoad = active === "A" ? deckBLoading : deckALoading;
    if (nowItem && !nowDeckInfo.track && !nowLoad)
      loadDeckSlot(active, nowItem, combinedLibrary);
    if (nextItem && !nextDeckInfo.track && !nextLoad)
      loadDeckSlot(active === "A" ? "B" : "A", nextItem, combinedLibrary);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, library]);

  // ── auto-crossfade ────────────────────────────────────────────────────────
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
        if (nextNext) loadDeckSlot(activeDeck, nextNext, combinedLibrary);
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

  // ── transport handlers ────────────────────────────────────────────────────
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
    if (nextNext) loadDeckSlot(activeDeck, nextNext, combinedLibrary);
    else {
      if (activeDeck === "A") setDeckA(emptyDeck());
      else setDeckB(emptyDeck());
    }
    didAutoXfade.current = false;
    setTimeout(() => setPlaybackStatus("playing"), fadeSecs * 1000);
  }, [engine, nextDeck, activeDeck, fadeSecs, library, loadDeckSlot]);

  // ── queue handlers ────────────────────────────────────────────────────────
  const handleAdd = useCallback(async (trackId: string) => {
    const qs = await addToQueue([trackId]);
    setQueue(qs.tracks);
  }, []);

  const handleRemove = useCallback(async (position: number) => {
    const qs = await removeFromQueue(position);
    setQueue(qs.tracks);
  }, []);

  const handleReorder = useCallback(
    async (from: number, to: number) => {
      setQueue((prev) => {
        const next = [...prev];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return next;
      });
      const nextSlot = queueCursorRef.current + 1;
      if (from === nextSlot || to === nextSlot) {
        if (activeDeck === "A") setDeckB(emptyDeck());
        else setDeckA(emptyDeck());
      }
      try {
        const qs = await reorderQueue(from, to);
        setQueue(qs.tracks);
      } catch (err) {
        console.error("[DJEnvironment] reorderQueue failed:", err);
        const qs = await fetchQueue();
        setQueue(qs.tracks);
      }
    },
    [activeDeck],
  );

  const handleSkipNext = useCallback(async () => {
    const cursorAtSkip = queueCursorRef.current;
    const nextPosition = cursorAtSkip + 1;
    if (nextPosition >= queueRef.current.length) return;
    const qs = await removeFromQueue(nextPosition);
    if (queueCursorRef.current !== cursorAtSkip) {
      setQueue(qs.tracks);
      return;
    }
    setQueue(qs.tracks);
    const active = activeDeckRef.current;
    if (active === "A") setDeckB(emptyDeck());
    else setDeckA(emptyDeck());
  }, []);

  const handleClear = useCallback(async () => {
    const qs = await clearQueue();
    setQueue(qs.tracks);
    setQueueCursor(0);
    setDeckA(emptyDeck());
    setDeckB(emptyDeck());
  }, []);

  const handleShuffle = useCallback(async (subset: TrackMeta[]) => {
    await clearQueue();
    setQueueCursor(0);
    setDeckA(emptyDeck());
    setDeckB(emptyDeck());
    const shuffled = [...subset].sort(() => Math.random() - 0.5);
    const qs = await addToQueue(shuffled.map((t) => t.track_id));
    setQueue(qs.tracks);
  }, []);

  // ── cue edit callbacks ────────────────────────────────────────────────────
  const handleNowCueUpdate = useCallback(
    (type: "entry" | "exit", sec: number) =>
      nowSet((d) => ({
        ...d,
        entry_sec: type === "entry" ? sec : d.entry_sec,
        exit_sec: type === "exit" ? sec : d.exit_sec,
      })),
    [nowSet],
  );
  const handleNextCueUpdate = useCallback(
    (type: "entry" | "exit", sec: number) =>
      nextSet((d) => ({
        ...d,
        entry_sec: type === "entry" ? sec : d.entry_sec,
        exit_sec: type === "exit" ? sec : d.exit_sec,
      })),
    [nextSet],
  );

  // ── keyboard shortcuts ─────────────────────────────────────────────────────
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

  useEffect(() => {
    if (!engine.state.isPlaying && playbackStatus === "playing")
      setPlaybackStatus("idle");
  }, [engine.state.isPlaying]);

  // ── UI view ───────────────────────────────────────────────────────────────
  const [view, setView] = useState<"dj" | "library">("dj");

  // ── render ─────────────────────────────────────────────────────────────────
  const nowLoading = activeDeck === "A" ? deckALoading : deckBLoading;
  const nextLoading = activeDeck === "A" ? deckBLoading : deckALoading;

  return (
    <div className="flex flex-col h-screen bg-[#07070f] text-white select-none">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex items-center gap-3 px-6 py-3 border-b border-white/5 shrink-0">
        <span className="text-purple-400 text-lg font-bold tracking-tight">
          Beat<span className="text-white">Bot</span>
        </span>
        <span className="text-gray-700 text-[10px] uppercase tracking-widest">
          AI DJ
        </span>

        {/* Tab nav */}
        <nav className="flex items-center gap-1 ml-4 p-0.5 rounded-lg bg-white/[0.04] border border-white/[0.06]">
          {(["dj", "library"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                view === v
                  ? "bg-purple-600 text-white"
                  : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {v === "dj" ? "DJ" : "Library"}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3 text-xs">
          {/* User info + Sign out */}
          {user && (
            <div className="flex items-center gap-3">
              <span className="text-gray-700 truncate max-w-[120px]">
                {user.email}
              </span>
              <button
                onClick={() => signOut()}
                className="text-gray-700 hover:text-gray-400 transition-colors"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      {view === "library" ? (
        <Library />
      ) : (
        <>
          {/* ── Decks + Queue ───────────────────────────────────────────────────── */}
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <div className="flex flex-col flex-1 p-3 min-w-0 min-h-0">
              <Deck
                role="NOW PLAYING"
                deck={nowDeck}
                elapsed={engine.state.elapsed}
                isLoading={nowLoading}
                onCueUpdate={handleNowCueUpdate}
              />
            </div>

            <div className="flex flex-col flex-1 p-3 min-w-0 min-h-0 border-l border-white/5">
              <Deck
                role="UP NEXT"
                deck={nextDeck}
                isLoading={nextLoading}
                onCueUpdate={handleNextCueUpdate}
                onSkip={handleSkipNext}
              />
            </div>

            <div className="flex flex-col w-80 shrink-0 p-3 min-h-0 border-l border-white/5">
              <Queue
                queue={queue}
                currentIndex={queueCursor}
                library={combinedLibrary}
                onAdd={handleAdd}
                onRemove={handleRemove}
                onReorder={handleReorder}
                onClear={handleClear}
                onShuffle={handleShuffle}
              />
            </div>
          </div>

          {/* ── Transport ───────────────────────────────────────────────────────── */}
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
        </>
      )}
    </div>
  );
}
