import { useState, useRef } from "react";
import type { QueueItem, TrackMeta } from "../types";

type CollectionFilter = "all" | "custom" | "m-djcue";

interface Props {
  queue: QueueItem[];
  currentIndex: number;
  library: TrackMeta[];
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

const FILTER_LABELS: Record<CollectionFilter, string> = {
  all: "All",
  custom: "Custom",
  "m-djcue": "M-DJCUE",
};

export default function Queue({
  queue,
  currentIndex,
  library,
  onAdd,
  onRemove,
  onReorder,
  onClear,
  onShuffle,
}: Props) {
  const [filter, setFilter] = useState<CollectionFilter>("all");
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const queuedIds = new Set(queue.map((q) => q.track_id));

  // All library tracks matching the filter (whether queued or not)
  const filteredLibrary = library.filter(
    (t) => filter === "all" || t.collection === filter,
  );

  // Available (not yet queued) tracks for the "click to add" section
  const available = filteredLibrary
    .filter((t) => !queuedIds.has(t.track_id))
    .sort((a, b) => a.track_id.localeCompare(b.track_id));

  return (
    <div className="flex flex-col h-full bg-[#0f0f1a] border border-white/5 rounded-xl overflow-hidden">
      {/* ── Top controls ─────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-white/5">
        {/* Header row */}
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-xs font-bold uppercase tracking-widest text-gray-400">
            Queue
          </span>
          {queue.length > 0 && (
            <button
              onClick={onClear}
              className="text-xs text-gray-600 hover:text-red-400 transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        {/* Collection filter tabs */}
        <div className="flex items-center gap-1 px-3 pb-2">
          {(Object.keys(FILTER_LABELS) as CollectionFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                filter === f
                  ? "bg-purple-700 text-white"
                  : "bg-gray-800/60 text-gray-500 hover:text-gray-300 hover:bg-gray-700/60"
              }`}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}

          {/* Shuffle button — shuffles current filtered subset */}
          <button
            onClick={() => onShuffle(filteredLibrary)}
            title={`Shuffle ${FILTER_LABELS[filter]} library into queue`}
            className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-gray-800/60 text-gray-500 hover:text-green-400 hover:bg-gray-700/60 transition-colors"
          >
            <span>⇄</span>
            <span>Shuffle</span>
          </button>
        </div>
      </div>

      {/* ── Scrollable body ───────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Active queue items */}
        {queue.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-gray-700 text-xs text-center px-4">
            Queue is empty — add tracks below or shuffle.
          </div>
        ) : (
          <ul className="divide-y divide-white/5">
            {queue.map((item, i) => {
              const isCurrent = i === currentIndex;
              const isPast = i < currentIndex;
              const isNext = i === currentIndex + 1;
              const isDraggable = !isCurrent && !isPast;
              const isDragOver = dragOverIndex === i;
              return (
                <li
                  key={`${item.track_id}-${i}`}
                  draggable={isDraggable}
                  onDragStart={isDraggable ? () => { dragIndexRef.current = i; } : undefined}
                  onDragEnter={isDraggable ? (e) => { e.preventDefault(); setDragOverIndex(i); } : undefined}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={isDraggable ? (e) => {
                    e.preventDefault();
                    const from = dragIndexRef.current;
                    if (from !== null && from !== i) onReorder(from, i);
                    dragIndexRef.current = null;
                    setDragOverIndex(null);
                  } : undefined}
                  onDragEnd={() => { dragIndexRef.current = null; setDragOverIndex(null); }}
                  className={`flex items-start gap-2 px-3 py-2 text-xs group transition-colors
                    ${isCurrent ? "bg-green-950/40" : isPast ? "opacity-35" : isNext ? "bg-blue-950/30" : "hover:bg-white/5"}
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
                    {isCurrent ? "▶" : isNext ? "◎" : i + 1}
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
              {FILTER_LABELS[filter]} library · click to add
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
