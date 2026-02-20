/**
 * WaveformView — MP3 waveform rendered by WaveSurfer.js.
 *
 * Displays the full audio waveform for a track. Entry and exit cue
 * positions are overlaid as coloured marker lines. The playhead
 * advances while the track plays (elapsed prop).
 */
import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { audioUrl } from "../api/client";

interface Props {
  trackId: string;
  entry_sec: number;
  exit_sec: number;
  duration: number;
  elapsed?: number; // seconds, for playhead
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function WaveformView({
  trackId,
  entry_sec,
  exit_sec,
  duration,
  elapsed = 0,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Create / recreate WaveSurfer whenever the trackId changes
  useEffect(() => {
    if (!containerRef.current) return;
    setLoading(true);
    setError(false);

    // Destroy previous instance
    if (wsRef.current) {
      wsRef.current.destroy();
      wsRef.current = null;
    }

    const ws = WaveSurfer.create({
      container: containerRef.current,
      url: audioUrl(trackId),
      waveColor: "#334155",
      progressColor: "#22c55e",
      cursorColor: "#22c55e",
      cursorWidth: 1,
      height: 72,
      normalize: true,
      interact: false, // playback controlled by Web Audio engine, not WS
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      minPxPerSec: 1,
    });

    ws.on("ready", () => setLoading(false));
    ws.on("error", () => {
      setLoading(false);
      setError(true);
    });

    wsRef.current = ws;

    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [trackId]);

  // Advance playhead (setTime without triggering playback)
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || loading || duration <= 0) return;
    try {
      ws.setTime(elapsed);
    } catch {
      // ignore if not ready
    }
  }, [elapsed, loading, duration]);

  const entryPct = duration > 0 ? (entry_sec / duration) * 100 : 0;
  const exitPct = duration > 0 ? (exit_sec / duration) * 100 : 0;
  const elapsedPct = duration > 0 ? (elapsed / duration) * 100 : 0;

  return (
    <div className="flex flex-col gap-1">
      <div className="border-t border-white/5 pt-1" />
      <p className="text-[10px] uppercase tracking-widest text-gray-600 font-semibold px-1">
        Waveform
      </p>

      <div className="relative bg-[#07070f] rounded-lg overflow-hidden border border-white/5">
        {/* WaveSurfer canvas mounts here */}
        <div ref={containerRef} className="w-full" />

        {/* Loading / error overlay */}
        {loading && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#07070f]/80">
            <div className="flex items-center gap-2 text-[10px] text-gray-600">
              <div className="w-3 h-3 border border-gray-600 border-t-transparent rounded-full animate-spin" />
              Loading waveform…
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[10px] text-gray-700">
              Waveform unavailable
            </span>
          </div>
        )}

        {/* Entry marker */}
        {!loading && !error && (
          <div
            className="absolute top-0 bottom-0 w-px bg-green-500/70 pointer-events-none"
            style={{ left: `${entryPct}%` }}
          >
            <span className="absolute top-0.5 left-1 text-[9px] text-green-400 font-mono whitespace-nowrap">
              ▶ {fmtTime(entry_sec)}
            </span>
          </div>
        )}

        {/* Exit marker */}
        {!loading && !error && (
          <div
            className="absolute top-0 bottom-0 w-px bg-red-500/70 pointer-events-none"
            style={{ left: `${exitPct}%` }}
          >
            <span className="absolute bottom-0.5 left-1 text-[9px] text-red-400 font-mono whitespace-nowrap">
              ⏹ {fmtTime(exit_sec)}
            </span>
          </div>
        )}

        {/* Shade played region */}
        {!loading && !error && elapsed > 0 && (
          <div
            className="absolute top-0 bottom-0 bg-green-500/5 pointer-events-none"
            style={{ left: 0, width: `${elapsedPct}%` }}
          />
        )}
      </div>

      {/* Time ruler */}
      <div className="flex justify-between text-[10px] text-gray-700 font-mono px-1">
        <span>0:00</span>
        <span>{fmtTime(duration / 2)}</span>
        <span>{fmtTime(duration)}</span>
      </div>
    </div>
  );
}
