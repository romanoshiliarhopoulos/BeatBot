import type { PlaybackStatus } from "../types";

interface Props {
  status: PlaybackStatus;
  isConnected: boolean;
  onPlay: () => void;
  onStop: () => void;
  onMixNow: () => void;
  fadeSecs: number;
  onFadeChange: (secs: number) => void;
  currentTrack: string | null;
  nextTrack: string | null;
  elapsed: number;
  exitSec: number;
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Transport({
  status,
  isConnected,
  onPlay,
  onStop,
  onMixNow,
  fadeSecs,
  onFadeChange,
  currentTrack,
  nextTrack,
  elapsed,
  exitSec,
}: Props) {
  const isPlaying = status === "playing" || status === "crossfading";
  const isLoading = status === "loading";

  const timeToExit = Math.max(0, exitSec - elapsed);

  return (
    <div className="flex items-center gap-4 bg-[#0a0a16] border-t border-white/5 px-6 py-3">
      {/* Play / Stop */}
      <button
        onClick={isPlaying ? onStop : onPlay}
        disabled={isLoading}
        className={`w-10 h-10 rounded-full flex items-center justify-center transition-all text-lg
          ${
            isLoading
              ? "bg-gray-800 text-gray-600 cursor-wait"
              : isPlaying
                ? "bg-gray-700 hover:bg-gray-600 text-white"
                : "bg-green-600 hover:bg-green-500 text-white shadow-lg shadow-green-900/40"
          }`}
      >
        {isLoading ? (
          <div className="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
        ) : isPlaying ? (
          "⏹"
        ) : (
          "▶"
        )}
      </button>

      {/* Status text */}
      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {currentTrack ? (
            <span className="text-white text-sm font-medium truncate">
              {currentTrack}
            </span>
          ) : (
            <span className="text-gray-600 text-sm italic">
              No track loaded
            </span>
          )}
          {isPlaying && (
            <span className="shrink-0 text-xs font-mono text-gray-400">
              {fmtTime(elapsed)}
            </span>
          )}
        </div>
        {nextTrack && isPlaying && (
          <div className="flex items-center gap-1 text-xs text-gray-500">
            <span className="text-blue-400">▸ next:</span>
            <span className="truncate">{nextTrack}</span>
            {timeToExit > 0 && (
              <span
                className={`ml-auto shrink-0 font-mono ${
                  timeToExit < 30 ? "text-yellow-400" : "text-gray-500"
                }`}
              >
                mix in {fmtTime(timeToExit)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Mix Now button */}
      {isPlaying && nextTrack && (
        <button
          onClick={onMixNow}
          title="Mix Now (Space)"
          className="px-3 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 text-white text-xs font-semibold transition-colors whitespace-nowrap flex items-center gap-1.5 shadow-lg shadow-purple-950/50"
        >
          Mix Now
          <kbd className="text-[10px] bg-purple-900 px-1 rounded opacity-70">
            ⎵
          </kbd>
        </button>
      )}

      {/* Fade duration */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-gray-600 text-xs">Fade</span>
        <select
          value={fadeSecs}
          onChange={(e) => onFadeChange(Number(e.target.value))}
          className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1"
        >
          {[3, 5, 7, 10, 15].map((s) => (
            <option key={s} value={s}>
              {s}s
            </option>
          ))}
        </select>
      </div>

      {/* WS status */}
      <div
        title={isConnected ? "Server connected" : "Disconnected"}
        className={`w-2 h-2 rounded-full shrink-0 ${
          isConnected ? "bg-green-500" : "bg-red-500"
        }`}
      />
    </div>
  );
}
