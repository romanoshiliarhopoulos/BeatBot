/**
 * DJEnvironment — the core DJ application.
 * This is the content of the original App.tsx, augmented with:
 * • auth user display + sign-out
 * • folder indicator + link back to onboarding
 */
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useQuery } from "@tanstack/react-query";

import type {
  DeckInfo,
  PredictResponse,
  QueueItem,
  TrackMeta,
  PlaybackStatus,
  PlayLengthProfile,
  TransitionConfig,
} from "../types";
import {
  fetchTracks,
  predictCues,
  fetchQueue,
  addToQueue,
  removeFromQueue,
  reorderQueue,
  clearQueue,
  suggestTransition,
} from "../api/client";
import { useAudioEngine } from "../hooks/useAudioEngine";
import type { ActiveDeck } from "../hooks/useAudioEngine";
import { useWebSocket } from "../hooks/useWebSocket";
import { useAuth } from "../contexts/AuthContext";
import { useFolders } from "../contexts/FolderContext";
import { useMixes } from "../contexts/MixContext";

import Deck from "../components/Deck";
import Queue from "../components/Queue";
import Transport from "../components/Transport";
import SessionPanel from "../components/SessionPanel";
import Library from "./Library";
import Discover from "./Discover.tsx";

// ── helpers ────────────────────────────────────────────────────────────────

const emptyDeck = (): DeckInfo => ({
  track: null,
  prediction: null,
  entry_sec: 0,
  exit_sec: 0,
});

const getPlayWindow = (
  durationSec: number,
  profile: PlayLengthProfile,
): { minBody: number; maxBody: number } => {
  const safeDuration = Math.max(30, durationSec);
  const maxPractical = Math.max(25, safeDuration * 0.92);

  const requested =
    profile === "short"
      ? { min: 90, max: 150 }
      : profile === "long"
        ? { min: 180, max: Number.POSITIVE_INFINITY }
        : { min: 150, max: 180 };

  const minBody = Math.max(25, Math.min(requested.min, safeDuration * 0.8));
  let maxBody =
    requested.max === Number.POSITIVE_INFINITY
      ? maxPractical
      : Math.min(requested.max, maxPractical);

  if (maxBody <= minBody) {
    maxBody = Math.max(minBody + 5, maxPractical);
  }

  return { minBody, maxBody };
};

const nearestIndex = (arr: number[], target: number): number => {
  if (!arr.length) return 0;
  let bestIndex = 0;
  let bestDist = Math.abs(arr[0] - target);
  for (let i = 1; i < arr.length; i += 1) {
    const d = Math.abs(arr[i] - target);
    if (d < bestDist) {
      bestDist = d;
      bestIndex = i;
    }
  }
  return bestIndex;
};

const argMax = (arr: number[]): number => {
  if (!arr.length) return 0;
  let best = 0;
  for (let i = 1; i < arr.length; i += 1) {
    if ((arr[i] ?? -Infinity) > (arr[best] ?? -Infinity)) best = i;
  }
  return best;
};

const adaptCuesToPlayLength = (
  pred: PredictResponse,
  profile: PlayLengthProfile,
): { entrySec: number; exitSec: number } => {
  const bars = pred.bar_times ?? [];
  if (bars.length < 2) {
    return { entrySec: pred.entry_sec, exitSec: pred.exit_sec };
  }

  const scoreIn = Array.from(
    { length: bars.length },
    (_, i) => pred.score_in?.[i] ?? 0,
  );
  const scoreOutRaw = Array.from(
    { length: bars.length },
    (_, i) => pred.score_out?.[i] ?? 0,
  );

  const duration = Math.max(1, bars[bars.length - 1] - bars[0]);
  const { minBody, maxBody } = getPlayWindow(duration, profile);

  const entryScoresWeighted = scoreIn.map((s, i) => {
    const pos = i / Math.max(bars.length - 1, 1);
    const earlyWeight = pos <= 0.55 ? 1 : Math.max(0, 1 - (pos - 0.55) / 0.25);
    return s * earlyWeight;
  });

  const exitScoresWeighted = scoreOutRaw.map((s, i) => {
    const pos = i / Math.max(bars.length - 1, 1);
    const lateWeight = Math.max(0, Math.min(1, 1 - (pos - 0.72) / 0.16));
    return s * lateWeight;
  });

  const baseEntry = argMax(entryScoresWeighted);
  const baseExit = argMax(exitScoresWeighted);

  const body = bars[baseExit] - bars[baseEntry];
  if (body >= minBody && body <= maxBody) {
    return { entrySec: bars[baseEntry], exitSec: bars[baseExit] };
  }

  let bestExit = -1;
  let bestExitScore = -Infinity;
  for (let i = 0; i < bars.length; i += 1) {
    const d = bars[i] - bars[baseEntry];
    if (d < minBody || d > maxBody) continue;
    const score = exitScoresWeighted[i] ?? 0;
    if (score > bestExitScore) {
      bestExitScore = score;
      bestExit = i;
    }
  }
  if (bestExit >= 0) {
    return { entrySec: bars[baseEntry], exitSec: bars[bestExit] };
  }

  const shift = Math.max(4, Math.floor(bars.length * 0.08));
  const lo = Math.max(0, baseEntry - shift);
  const hi = Math.min(bars.length - 1, baseEntry + shift);

  let bestEntry = baseEntry;
  let bestPairExit = Math.max(baseEntry + 1, baseExit);
  let bestPairScore = -Infinity;

  for (let e = lo; e <= hi; e += 1) {
    for (let x = e + 1; x < bars.length; x += 1) {
      const d = bars[x] - bars[e];
      if (d < minBody || d > maxBody) continue;

      const inScore = entryScoresWeighted[e] ?? 0;
      const outScore = exitScoresWeighted[x] ?? 0;
      const entryPenalty = (0.32 * Math.abs(e - baseEntry)) / bars.length;
      const exitPenalty = (0.08 * Math.abs(x - baseExit)) / bars.length;
      const pairScore =
        0.35 * inScore + 0.65 * outScore - entryPenalty - exitPenalty;

      if (pairScore > bestPairScore) {
        bestPairScore = pairScore;
        bestEntry = e;
        bestPairExit = x;
      }
    }
  }

  if (bestPairScore > -Infinity) {
    return { entrySec: bars[bestEntry], exitSec: bars[bestPairExit] };
  }

  const fallbackExitTarget = Math.min(
    bars[bars.length - 1],
    bars[baseEntry] + maxBody,
  );
  const fallbackExit = Math.max(
    baseEntry + 1,
    nearestIndex(bars, fallbackExitTarget),
  );
  return { entrySec: bars[baseEntry], exitSec: bars[fallbackExit] };
};

// ── DJEnvironment ──────────────────────────────────────────────────────────

export default function DJEnvironment() {
  const { user, signOut } = useAuth();
  const { getFileByTrackId, folders, addFolder } = useFolders();
  const { mixes } = useMixes();

  const [selectedMixId, setSelectedMixId] = useState<string | null>(null);

  const { data: library = [] } = useQuery<TrackMeta[]>({
    queryKey: ["tracks"],
    queryFn: fetchTracks,
    staleTime: 60_000,
  });

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
  }, [queue.length, queueCursor, setQueueCursor]);

  const [deckA, setDeckA] = useState<DeckInfo>(emptyDeck);
  const [deckB, setDeckB] = useState<DeckInfo>(emptyDeck);
  const [activeDeck, setActiveDeck] = useState<ActiveDeck>("A");
  useEffect(() => {
    activeDeckRef.current = activeDeck;
  }, [activeDeck]);
  const [deckALoading, setDeckALoading] = useState(false);
  const [deckBLoading, setDeckBLoading] = useState(false);

  useEffect(() => {
    return () => {
      if (deckA.audioSrc) URL.revokeObjectURL(deckA.audioSrc);
    };
  }, [deckA.audioSrc]);

  useEffect(() => {
    return () => {
      if (deckB.audioSrc) URL.revokeObjectURL(deckB.audioSrc);
    };
  }, [deckB.audioSrc]);

  const [fadeSecs, setFadeSecs] = useState(7);
  const [playLength, setPlayLength] = useState<PlayLengthProfile>("medium");
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus>("idle");
  const didAutoXfade = useRef(false);

  const engine = useAudioEngine();
  const { isConnected, lastEvent, sendMessage: wsSendMessage } = useWebSocket();

  const nowDeck = activeDeck === "A" ? deckA : deckB;
  const nowSet = activeDeck === "A" ? setDeckA : setDeckB;
  const nextDeck = activeDeck === "A" ? deckB : deckA;
  const nextSet = activeDeck === "A" ? setDeckB : setDeckA;

  const [transitionOverride, setTransitionOverride] = useState<
    TransitionConfig["type"] | "auto"
  >("auto");
  const [suggestedConfig, setSuggestedConfig] =
    useState<TransitionConfig | null>(null);

  useEffect(() => {
    if (!nowDeck.track || !nextDeck.track) {
      setSuggestedConfig(null);
      return;
    }
    let cancelled = false;
    suggestTransition(
      nowDeck.track.track_id,
      nextDeck.track.track_id,
      nowDeck.exit_sec,
      nextDeck.entry_sec,
      fadeSecs,
    )
      .then((cfg) => {
        if (!cancelled) setSuggestedConfig(cfg);
      })
      .catch((err) => {
        console.warn("[DJEnvironment] transition suggest failed:", err);
        if (!cancelled) setSuggestedConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    nowDeck.track?.track_id,
    nowDeck.exit_sec,
    nextDeck.track?.track_id,
    nextDeck.entry_sec,
    fadeSecs,
  ]);

  const transitionConfig: TransitionConfig | null = !suggestedConfig
    ? null
    : transitionOverride === "auto"
      ? suggestedConfig
      : { ...suggestedConfig, type: transitionOverride };

  const loadDeckSlot = useCallback(
    async (slot: ActiveDeck, item: QueueItem, lib: TrackMeta[]) => {
      const setLoading = slot === "A" ? setDeckALoading : setDeckBLoading;
      const setSlot = slot === "A" ? setDeckA : setDeckB;

      setLoading(true);
      try {
        const file = await getFileByTrackId(item.track_id);
        
        if (!file) {
          console.warn(`[DJEnvironment] Audio file not found for track: ${item.track_id}`);
          setLoading(false);
          return;
        }

        const audioPromise = engine.loadDeck(
          slot,
          item.track_id,
          file,
        );

        const predPromise = predictCues(item.track_id);

        let pred = await Promise.all([audioPromise, predPromise])
          .then(([, p]) => p)
          .catch(async (err) => {
            console.warn(
              `[DJEnvironment] predict fallback for ${item.track_id}:`,
              err,
            );
            // Use backend-provided cues as fallback instead of zeros so
            // auto-crossfade triggerAt = exit_sec - fadeSecs stays positive.
            return {
              track_id: item.track_id,
              num_bars: 0,
              bar_times: [] as number[],
              score_in: [] as number[],
              score_out: [] as number[],
              entry_sec: item.entry_sec ?? 0,
              exit_sec: item.exit_sec > 0 ? item.exit_sec : 180,
              method: "heuristic" as const,
            };
          });

        const track: TrackMeta = lib.find((t) => t.track_id === item.track_id) ?? {
          track_id: item.track_id,
          duration: (pred as import("../types").PredictResponse).exit_sec ?? 0,
          tempo: 0,
          key: null,
          camelot: null,
          num_bars: (pred as import("../types").PredictResponse).num_bars ?? 0,
          has_cue_labels: false,
          collection: 'custom',
        };
        const p = pred as import("../types").PredictResponse;
        const adapted = adaptCuesToPlayLength(pred, playLength);

        setSlot({
          track,
          prediction: pred,
          entry_sec: adapted.entrySec,
          exit_sec: adapted.exitSec,
          audioSrc: URL.createObjectURL(file),
        });
        
        // Only clear loading flag after audio has been successfully set up
        setLoading(false);
      } catch (err) {
        console.error(`[DJEnvironment] loadDeckSlot ${slot}:`, err);
        setLoading(false);
      }
    },
    // Use engine.loadDeck (stable useCallback) rather than the whole engine
    // object (recreated every 250 ms by the ticker) to prevent loadDeckSlot
    // from being recreated on every tick, which in turn caused the
    // auto-crossfade effect to re-register constantly and load decks twice.
    [engine.loadDeck, getFileByTrackId, playLength],
  );

  useEffect(() => {
    const adaptDeck = (setDeck: Dispatch<SetStateAction<DeckInfo>>) => {
      setDeck((current) => {
        if (!current.track || !current.prediction) return current;
        const adapted = adaptCuesToPlayLength(current.prediction, playLength);
        return {
          ...current,
          entry_sec: adapted.entrySec,
          exit_sec: adapted.exitSec,
        };
      });
    };

    adaptDeck(setDeckA);
    adaptDeck(setDeckB);
  }, [playLength]);

  useEffect(() => {
    fetchQueue().then((qs) => setQueue(qs.tracks));
  }, []);

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
  }, [queue, library, loadDeckSlot]); // Include loadDeckSlot if linting requires

  useEffect(() => {
    if (!engine.state.isPlaying) return;
    const active = activeDeck === "A" ? deckA : deckB;
    const inactive = activeDeck === "A" ? deckB : deckA;
    const nextLoad = activeDeck === "A" ? deckBLoading : deckALoading;
    const triggerAt = active.exit_sec - fadeSecs;
    const timePastTrigger = engine.state.elapsed - triggerAt;
    
    if (
      engine.state.elapsed >= triggerAt &&
      triggerAt > 0 &&
      !didAutoXfade.current
    ) {
      // CRITICAL: Mark as executed IMMEDIATELY to prevent multiple fires from effect re-runs
      didAutoXfade.current = true;

      // Guard: if next deck is still loading audio, wait before proceeding
      if (nextLoad && timePastTrigger < 5) {
        // Still loading and we're within grace period - wait and try again next tick
        console.log('[DJEnvironment] Auto-transition blocked: next deck audio still loading', {
          timePastTrigger: timePastTrigger.toFixed(2),
        });
        return;
      }

      if (nextLoad && timePastTrigger >= 5) {
        console.warn('[DJEnvironment] Auto-transition timeout: next deck still loading', {
          timePastTrigger: timePastTrigger.toFixed(2),
          trackId: inactive.track?.id,
          incomingDeckEngineSource: activeDeck === "A" ? engine.state.deckB?.source : engine.state.deckA?.source,
          nextLoad,
        });
        // Do NOT proceed if audio still isn't loaded - just skip this transition
        // and wait for the next trigger point or manual interaction
        return;
      }

      if (inactive.track) {
        setPlaybackStatus("crossfading");
        engine.crossfadeNow(
          inactive.entry_sec,
          fadeSecs,
          transitionConfig ?? undefined,
        );
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
        const effectiveFade = transitionConfig?.fadeSecs ?? fadeSecs;
        setTimeout(() => {
          setPlaybackStatus("playing");
          didAutoXfade.current = false;
        }, effectiveFade * 1000);
      } else {
        didAutoXfade.current = false;
      }
    }
  }, [
    engine.state.elapsed,
    engine.state.isPlaying,
    activeDeck,
    deckA,
    deckB,
    fadeSecs,
    transitionConfig,
    combinedLibrary,
    loadDeckSlot,
    setQueueCursor,
    deckALoading,
    deckBLoading,
  ]);

  useEffect(() => {
    if (!lastEvent) return;
    if (lastEvent.type === "queue.updated") {
      const newTracks = lastEvent.tracks;
      setQueue(newTracks);

      const cursor = queueCursorRef.current;
      const nextItem = newTracks[cursor + 1];
      const active = activeDeckRef.current;
      const loadedNext = active === "A" ? deckB : deckA;
      if (
        nextItem &&
        loadedNext.track &&
        loadedNext.track.track_id !== nextItem.track_id
      ) {
        const inactiveSlot: ActiveDeck = active === "A" ? "B" : "A";
        loadDeckSlot(inactiveSlot, nextItem, combinedLibrary);
      }
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
  }, [lastEvent, combinedLibrary, loadDeckSlot]);

  // ── FIX: AGGRESSIVE WEBSOCKET BROADCASTER ──
  // This physically forces the DJ's local state out to the backend whenever it changes.
  useEffect(() => {
    if (!isConnected) return;
    wsSendMessage({
      type: "queue.update",
      queue: queue,
      current_index: queueCursor,
    });
  }, [queue, queueCursor, isConnected, wsSendMessage]);

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
    engine.crossfadeNow(
      nextDeck.entry_sec,
      fadeSecs,
      transitionConfig ?? undefined,
    );
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
    const effectiveFade = transitionConfig?.fadeSecs ?? fadeSecs;
    setTimeout(() => setPlaybackStatus("playing"), effectiveFade * 1000);
  }, [
    engine,
    nextDeck,
    activeDeck,
    fadeSecs,
    transitionConfig,
    combinedLibrary,
    loadDeckSlot,
    setQueueCursor,
  ]);

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
  }, [setQueueCursor]);

  const handleShuffle = useCallback(
    async (subset: TrackMeta[]) => {
      await clearQueue();
      setQueueCursor(0);
      setDeckA(emptyDeck());
      setDeckB(emptyDeck());
      const shuffled = [...subset].sort(() => Math.random() - 0.5);
      const qs = await addToQueue(shuffled.map((t) => t.track_id));
      setQueue(qs.tracks);
    },
    [setQueueCursor],
  );

  const handleSelectMix = useCallback(
    async (mixId: string | null) => {
      setSelectedMixId(mixId);
      await clearQueue();
      setQueueCursor(0);
      setDeckA(emptyDeck());
      setDeckB(emptyDeck());
      if (mixId) {
        const mix = mixes.find((m) => m.id === mixId);
        if (mix && mix.trackIds.length > 0) {
          const qs = await addToQueue(mix.trackIds);
          setQueue(qs.tracks);
          return;
        }
      }
      setQueue([]);
    },
    [mixes, setQueueCursor],
  );

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
  }, [engine.state.isPlaying, playbackStatus]);

  useEffect(() => {
    if (!engine.state.isPlaying) return;
    if (!nowDeck.track) return;
    engine.rescheduleTransition(nowDeck.exit_sec, fadeSecs);
  }, [
    nowDeck.track,
    nowDeck.exit_sec,
    fadeSecs,
    engine.state.isPlaying,
    engine.rescheduleTransition,
  ]);

  const [view, setView] = useState<"dj" | "library" | "discover">("dj");

  const nowLoading = activeDeck === "A" ? deckALoading : deckBLoading;
  const nextLoading = activeDeck === "A" ? deckBLoading : deckALoading;

  return (
    <div className="flex flex-col h-screen bg-[#07070f] text-white select-none">
      <header className="flex items-center gap-3 px-6 py-3 border-b border-white/5 shrink-0">
        <span className="text-purple-400 text-lg font-bold tracking-tight">
          Beat<span className="text-white">Bot</span>
        </span>
        <span className="text-gray-700 text-[10px] uppercase tracking-widest">
          AI DJ
        </span>

        <nav className="flex items-center gap-1 ml-4 p-0.5 rounded-lg bg-white/[0.04] border border-white/[0.06]">
          {(["dj", "library", "discover"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                view === v
                  ? "bg-purple-600 text-white"
                  : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {v === "dj" ? "DJ" : v === "library" ? "Library" : "Discover"}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3 text-xs">
          {folders.length === 0 ? (
            <button
              onClick={addFolder}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-900/30 border border-amber-700/40 text-amber-400 text-[11px] hover:bg-amber-800/40 transition-colors"
              title="Link your local music folder so BeatBot can play audio"
            >
              <span>⚠</span>
              <span>Link music folder</span>
            </button>
          ) : (
            <button
              onClick={addFolder}
              className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-gray-600 hover:text-gray-400 transition-colors"
              title={`Linked to: ${folders[0].name} — click to change folder`}
            >
              <span className="text-green-500">●</span>
              <span>Linked: {folders[0].name}</span>
            </button>
          )}

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
      ) : view === "discover" ? (
        <Discover />
      ) : (
        <>
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

            <div className="flex flex-col w-80 shrink-0 p-3 min-h-0 border-l border-white/5 gap-3">
              <div className="flex-1 min-h-0">
                <Queue
                  queue={queue}
                  currentIndex={queueCursor}
                  library={combinedLibrary}
                  mixes={mixes}
                  selectedMixId={selectedMixId}
                  onSelectMix={handleSelectMix}
                  onAdd={handleAdd}
                  onRemove={handleRemove}
                  onReorder={handleReorder}
                  onClear={handleClear}
                  onShuffle={handleShuffle}
                />
              </div>
              <div className="h-64 shrink-0">
                <SessionPanel
                  lastWsEvent={lastEvent}
                  sendWsMessage={wsSendMessage}
                />
              </div>
            </div>
          </div>

          <div className="shrink-0">
            <Transport
              status={playbackStatus}
              isConnected={isConnected}
              onPlay={handlePlay}
              onStop={handleStop}
              onMixNow={handleMixNow}
              fadeSecs={fadeSecs}
              onFadeChange={setFadeSecs}
              playLength={playLength}
              onPlayLengthChange={setPlayLength}
              currentTrack={nowDeck.track?.track_id ?? null}
              nextTrack={nextDeck.track?.track_id ?? null}
              elapsed={engine.state.elapsed}
              exitSec={nowDeck.exit_sec}
              transitionType={transitionConfig?.type ?? null}
              suggestedType={suggestedConfig?.type ?? null}
              transitionOverride={transitionOverride}
              onTransitionOverrideChange={setTransitionOverride}
            />
          </div>
        </>
      )}
    </div>
  );
}
