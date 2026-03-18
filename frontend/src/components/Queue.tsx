import { useRef, useState } from "react";
import type { QueueItem, TrackMeta, Mix } from "../types";

interface Props {
  queue: QueueItem[];
  currentIndex: number;
  library: TrackMeta[];
  mixes: Mix[];
  selectedMixId: string | null;
  onSelectMix: (mixId: string | null) => void;
  onAdd: (trackId: string) => void;
  onRemove: (position: number) => void;
  onReorder: (fromPosition: number, toPosition: number) => void;
  onClear: () => void;
  onShuffle: (subset: TrackMeta[]) => void;
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Queue({
  queue,
  currentIndex,
  library,
  mixes,
  selectedMixId,
  onSelectMix,
  onAdd,
  onRemove,
  onReorder,
  onClear,
  onShuffle,
}: Props) {
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Hide history: only show current + upcoming queue entries.
  const startIndex = Math.min(Math.max(currentIndex, 0), queue.length);
  const visibleQueue = queue.slice(startIndex);

  const queuedIds = new Set(visibleQueue.map((q) => q.track_id));

  // If a mix is selected, use its tracks in mix order; otherwise all library alpha-sorted
  const selectedMix = mixes.find((m) => m.id === selectedMixId) ?? null;
  const filteredLibrary: TrackMeta[] = selectedMix
    ? selectedMix.trackIds
        .map((id) => library.find((t) => t.track_id === id))
        .filter((t): t is TrackMeta => t != null)
    : [...library].sort((a, b) => a.track_id.localeCompare(b.track_id));

  // Available (not yet queued) tracks
  const available = filteredLibrary.filter((t) => !queuedIds.has(t.track_id));

  const mixLabel = selectedMix ? selectedMix.name : "All Library";

  return (
    <div className="flex flex-col h-full bg-[#0f0f1a] border border-white/5 rounded-xl overflow-hidden">
      {/* ── Top controls ─────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-white/5">
        {/* Header row */}
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-xs font-bold uppercase tracking-widest text-gray-400">
            Queue
          </span>
          {visibleQueue.length > 0 && (
            <button
              onClick={onClear}
              className="text-xs text-gray-600 hover:text-red-400 transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        {/* Mix selector + shuffle */}
        <div className="flex items-center gap-2 px-3 pb-2">
          <select
            value={selectedMixId ?? ""}
            onChange={(e) => onSelectMix(e.target.value || null)}
            className="flex-1 min-w-0 px-2.5 py-1 rounded bg-gray-800/60 border border-white/[0.06]
              text-[11px] font-medium text-gray-300 focus:outline-none focus:border-purple-500/50
              cursor-pointer appearance-none"
            title="Select a mix"
          >
            <option value="">All Library</option>
            {mixes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>

          <button
            onClick={() => onShuffle(filteredLibrary)}
            title={`Shuffle ${mixLabel} into queue`}
            className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium
              bg-gray-800/60 text-gray-500 hover:text-green-400 hover:bg-gray-700/60 transition-colors"
          >
            <span>⇄</span>
            <span>Shuffle</span>
          </button>
        </div>
      </div>

      {/* ── Scrollable body ───────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Active queue items */}
        {visibleQueue.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-gray-700 text-xs text-center px-4">
            Queue is empty — add tracks below or shuffle.
          </div>
        ) : (
          <ul className="divide-y divide-white/5">
            {visibleQueue.map((item, visibleIndex) => {
              const actualIndex = startIndex + visibleIndex;
              const isCurrent = visibleIndex === 0;
              const isNext = visibleIndex === 1;
              const isDraggable = !isCurrent;
              const isDragOver = dragOverIndex === actualIndex;
              return (
                <li
                  key={`${item.track_id}-${actualIndex}`}
                  data-queue-index={actualIndex}
                  draggable={isDraggable}
                  onDragStart={
                    isDraggable
                      ? () => {
                          dragIndexRef.current = actualIndex;
                        }
                      : undefined
                  }
                  onDragEnter={
                    isDraggable
                      ? (e) => {
                          e.preventDefault();
                          setDragOverIndex(actualIndex);
                        }
                      : undefined
                  }
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={
                    isDraggable
                      ? (e) => {
                          e.preventDefault();
                          const from = dragIndexRef.current;
                          if (from !== null && from !== actualIndex)
                            onReorder(from, actualIndex);
                          dragIndexRef.current = null;
                          setDragOverIndex(null);
                        }
                      : undefined
                  }
                  onDragEnd={() => {
                    dragIndexRef.current = null;
                    setDragOverIndex(null);
                  }}
                  className={`flex items-start gap-2 px-3 py-2 text-xs group transition-colors
                    ${isCurrent ? "bg-green-950/40" : isNext ? "bg-blue-950/30" : "hover:bg-white/5"}
                    ${isDragOver ? "border-t-2 border-purple-400" : ""}
                  `}
                >
                  <span
                    className={`shrink-0 w-5 text-center font-mono pt-0.5 ${
                      isCurrent
                        ? "text-green-400"
                        : isNext
                          ? "text-blue-400"
                          : "text-gray-600"
                    }`}
                  >
                    {isCurrent ? "▶" : isNext ? "◎" : visibleIndex + 1}
                  </span>

                  {/* Drag handle — only shown for future (draggable) items */}
                  {isDraggable && (
                    <span className="shrink-0 text-gray-700 group-hover:text-gray-500 cursor-grab active:cursor-grabbing pt-0.5 select-none">
                      ⠿
                    </span>
                  )}

                  <div className="flex-1 min-w-0">
                    <p
                      className={`truncate leading-snug ${
                        isCurrent
                          ? "text-white"
                          : isNext
                            ? "text-gray-200"
                            : "text-gray-400"
                      }`}
                    >
                      {item.track_id}
                    </p>
                    <p className="text-gray-600 font-mono mt-0.5">
                      ▶ {fmtTime(item.entry_sec)} · ⏹ {fmtTime(item.exit_sec)}
                    </p>
                  </div>

                  {!isCurrent && (
                    <button
                      onClick={() => onRemove(item.position)}
                      className="shrink-0 text-gray-700 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 px-1 pt-0.5"
                    >
                      ×
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* Library — available tracks */}
        {available.length > 0 && (
          <div className="px-3 pt-4 pb-1">
            <p className="text-[10px] uppercase tracking-widest text-gray-600 font-semibold">
              {mixLabel} · click to add
            </p>
          </div>
        )}

        <ul className="divide-y divide-white/5">
          {available.map((t) => (
            <li key={t.track_id}>
              <button
                onClick={() => onAdd(t.track_id)}
                className="w-full text-left px-3 py-2 text-xs hover:bg-white/5 transition-colors group"
              >
                <div className="flex items-center gap-2">
                  <span className="text-gray-600 group-hover:text-purple-400 transition-colors shrink-0">
                    +
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-500 group-hover:text-gray-300 truncate transition-colors">
                      {t.track_id}
                    </p>
                    <p className="text-gray-700 font-mono text-[10px]">
                      {t.tempo.toFixed(0)} BPM
                      {t.camelot ? ` · ${t.camelot}` : ""}
                      {" · "}
                      {fmtTime(t.duration)}
                    </p>
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
