import { useState } from "react";
import type { DeckInfo } from "../types";
import CueChart from "./CueChart";
import FeatureCharts from "./FeatureCharts";
import WaveformView from "./WaveformView";
import ErrorBoundary from "./ErrorBoundary";
import { editCue } from "../api/client";

interface Props {
  role: "NOW PLAYING" | "UP NEXT";
  deck: DeckInfo;
  elapsed?: number; // only used for NOW PLAYING progress bar
  isLoading?: boolean;
  onCueUpdate: (type: "entry" | "exit", sec: number) => void;
  onSkip?: () => void;
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Deck({
  role,
  deck,
  elapsed,
  isLoading,
  onCueUpdate,
  onSkip,
}: Props) {
  const [saving, setSaving] = useState(false);
  const isPlaying = role === "NOW PLAYING";

  const handleCueEdit = async (type: "entry" | "exit", sec: number) => {
    if (!deck.track) return;
    setSaving(true);
    try {
      const resp = await editCue(deck.track.track_id, {
        cue_type: type,
        timestamp_sec: sec,
        source: "user_drag",
      });
      onCueUpdate(type, resp.accepted_sec);
    } catch (err) {
      console.error("Cue edit failed:", err);
    } finally {
      setSaving(false);
    }
  };

  const borderClass = isPlaying ? "border-green-500/40" : "border-blue-500/20";
  const roleClass = isPlaying ? "text-green-400" : "text-blue-400";

  // Progress bar (NOW PLAYING only)
  const progress =
    deck.track && elapsed !== undefined
      ? Math.min(elapsed / deck.track.duration, 1)
      : 0;

  return (
    <div
      className={`flex flex-col gap-3 bg-[#0f0f1a] border ${borderClass} rounded-xl p-4 h-full`}
    >
      {/* Role badge */}
      <div className="flex items-center justify-between">
        <span
          className={`text-xs font-bold uppercase tracking-widest ${roleClass}`}
        >
          {role}
        </span>
        <div className="flex items-center gap-2">
          {saving && (
            <span className="text-xs text-yellow-400 animate-pulse">
              saving…
            </span>
          )}
          {role === "UP NEXT" && deck.track && onSkip && (
            <button
              onClick={onSkip}
              title="Skip — remove this track and load the next one"
              className="flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-gray-800 text-gray-400 hover:bg-red-900/50 hover:text-red-400 transition-colors"
            >
              <span>⏭</span>
              <span>Skip</span>
            </button>
          )}
        </div>
      </div>

      {/* Track info */}
      {deck.track ? (
        <div>
          <h2 className="text-white font-semibold text-sm leading-snug line-clamp-2">
            {deck.track.track_id}
          </h2>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-gray-400 text-xs font-mono">
              {deck.track.tempo.toFixed(0)} BPM
            </span>
            {deck.track.camelot && (
              <span className="text-xs bg-purple-900/50 text-purple-300 px-1.5 py-0.5 rounded font-mono">
                {deck.track.camelot}
              </span>
            )}
            {deck.track.key && (
              <span className="text-gray-500 text-xs">{deck.track.key}</span>
            )}
            <span className="text-gray-600 text-xs ml-auto">
              {fmtTime(deck.track.duration)}
            </span>
          </div>
        </div>
      ) : (
        <div className="text-gray-600 text-sm italic">
          {isLoading ? "Loading…" : "No track loaded"}
        </div>
      )}

      {/* Progress bar (NOW PLAYING) */}
      {isPlaying && deck.track && (
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-gray-400 w-10">
            {elapsed !== undefined ? fmtTime(elapsed) : "--:--"}
          </span>
          <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full transition-all duration-250"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
          <span className="font-mono text-xs text-gray-600 w-10 text-right">
            {fmtTime(deck.track.duration)}
          </span>
        </div>
      )}

      {/* Charts: scrollable area containing all visualisations */}
      {deck.prediction ? (
        <div className="flex-1 overflow-y-auto min-h-0 -mx-1 px-1">
          <div className="flex flex-col gap-4 pb-2">
            {/* Shared syncId ties cursor across all charts for this deck */}
            {(() => {
              const syncId = deck.track?.track_id ?? "deck";
              return (
                <ErrorBoundary label="Charts">
                  {/* 1. Cue probability chart */}
                  <CueChart
                    prediction={deck.prediction}
                    entry_sec={deck.entry_sec}
                    exit_sec={deck.exit_sec}
                    onCueEdit={handleCueEdit}
                    isEditable={true}
                    syncId={syncId}
                    elapsed={isPlaying ? elapsed : undefined}
                  />

                  {/* 2. Feature charts (energy, beat strength, vocals) */}
                  <FeatureCharts
                    prediction={deck.prediction}
                    entry_sec={deck.entry_sec}
                    exit_sec={deck.exit_sec}
                    syncId={syncId}
                    elapsed={isPlaying ? elapsed : undefined}
                  />

                  {/* 3. MP3 waveform — rendered for both decks using local file URL */}
                  {deck.track && (
                    <WaveformView
                      trackId={deck.track.track_id}
                      src={deck.audioSrc}
                      entry_sec={deck.entry_sec}
                      exit_sec={deck.exit_sec}
                      duration={deck.track.duration}
                      elapsed={isPlaying ? elapsed : undefined}
                      decodeDelay={isPlaying ? 2000 : 6000}
                    />
                  )}
                </ErrorBoundary>
              );
            })()}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          {isLoading ? (
            <div className="flex flex-col items-center gap-2">
              <div className="w-6 h-6 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-gray-600 text-xs">Analysing cues…</span>
            </div>
          ) : (
            <div className="text-gray-700 text-xs text-center">
              Add a track to the queue to see cue analysis
            </div>
          )}
        </div>
      )}
    </div>
  );
}
