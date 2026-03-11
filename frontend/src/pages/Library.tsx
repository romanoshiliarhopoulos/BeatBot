/**
 * Library — mix management hub.
 *
 * Views:
 *   grid   — Apple-Music-style cards: pinned "Library" card + user mixes + "+" card
 *   manage — original track-management table (delete / purge / clear)
 *   mix    — mix editor: rename, reorder, search & add/remove tracks
 */
import { useState, useRef, useEffect } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";

import type { TrackMeta, Mix } from "../types";
import {
  fetchTracks,
  fetchFeatureIds,
  deleteTrack,
  purgeTracks,
  clearAllTracks,
} from "../api/client";
import { useFolders } from "../contexts/FolderContext";
import { useMixes } from "../contexts/MixContext";

// ── helpers ───────────────────────────────────────────────────────────────

function fmt(secs: number): string {
  if (!secs) return "—";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtTotal(trackIds: string[], library: TrackMeta[]): string {
  const total = trackIds.reduce((acc, id) => {
    const t = library.find((tr) => tr.track_id === id);
    return acc + (t?.duration ?? 0);
  }, 0);
  if (!total) return "";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(total)}s`;
}

// ── color palette ────────────────────────────────────────────────────────

export const MIX_COLORS: Record<
  string,
  { gradient: string; border: string; swatch: string; subtitleColor: string }
> = {
  purple: {
    gradient: "linear-gradient(135deg, #6d28d9 0%, #312e81 100%)",
    border: "rgba(139,92,246,0.35)",
    swatch: "#7c3aed",
    subtitleColor: "rgba(196,181,253,0.65)",
  },
  indigo: {
    gradient: "linear-gradient(135deg, #4338ca 0%, #1e1b4b 100%)",
    border: "rgba(99,102,241,0.35)",
    swatch: "#4338ca",
    subtitleColor: "rgba(199,210,254,0.65)",
  },
  blue: {
    gradient: "linear-gradient(135deg, #1d4ed8 0%, #172554 100%)",
    border: "rgba(59,130,246,0.35)",
    swatch: "#2563eb",
    subtitleColor: "rgba(191,219,254,0.65)",
  },
  teal: {
    gradient: "linear-gradient(135deg, #0f766e 0%, #042f2e 100%)",
    border: "rgba(20,184,166,0.35)",
    swatch: "#0d9488",
    subtitleColor: "rgba(153,246,228,0.65)",
  },
  green: {
    gradient: "linear-gradient(135deg, #15803d 0%, #052e16 100%)",
    border: "rgba(34,197,94,0.35)",
    swatch: "#16a34a",
    subtitleColor: "rgba(187,247,208,0.65)",
  },
  amber: {
    gradient: "linear-gradient(135deg, #b45309 0%, #451a03 100%)",
    border: "rgba(245,158,11,0.35)",
    swatch: "#d97706",
    subtitleColor: "rgba(253,230,138,0.65)",
  },
  orange: {
    gradient: "linear-gradient(135deg, #c2410c 0%, #431407 100%)",
    border: "rgba(249,115,22,0.35)",
    swatch: "#ea580c",
    subtitleColor: "rgba(254,215,170,0.65)",
  },
  rose: {
    gradient: "linear-gradient(135deg, #be123c 0%, #4c0519 100%)",
    border: "rgba(244,63,94,0.35)",
    swatch: "#e11d48",
    subtitleColor: "rgba(254,205,211,0.65)",
  },
  pink: {
    gradient: "linear-gradient(135deg, #9d174d 0%, #500724 100%)",
    border: "rgba(236,72,153,0.35)",
    swatch: "#db2777",
    subtitleColor: "rgba(251,207,232,0.65)",
  },
  slate: {
    gradient: "linear-gradient(135deg, #475569 0%, #0f172a 100%)",
    border: "rgba(100,116,139,0.35)",
    swatch: "#64748b",
    subtitleColor: "rgba(203,213,225,0.65)",
  },
};

const DEFAULT_COLOR = "purple";

// ── MixSetupModal ─────────────────────────────────────────────────────────

function MixSetupModal({
  initial,
  onConfirm,
  onCancel,
}: {
  initial: { name: string; color: string };
  onConfirm: (result: { name: string; color: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState(initial.color || DEFAULT_COLOR);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function handleSubmit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onConfirm({ name: trimmed, color });
  }

  const palette = MIX_COLORS[color] ?? MIX_COLORS[DEFAULT_COLOR];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-sm mx-4 rounded-2xl bg-[#13131f] border border-white/[0.09] shadow-2xl overflow-hidden">
        {/* Preview strip */}
        <div
          className="h-20 flex items-end px-5 pb-3"
          style={{ background: palette.gradient }}
        >
          <span className="text-white font-semibold text-base truncate drop-shadow">
            {name.trim() || "New Mix"}
          </span>
        </div>

        <div className="p-5 flex flex-col gap-5">
          {/* Name input */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">
              Name
            </label>
            <input
              ref={inputRef}
              value={name}
              placeholder="Mix name…"
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
                if (e.key === "Escape") onCancel();
              }}
              className="px-3 py-2 rounded-lg bg-white/[0.06] border border-white/[0.09]
                text-white text-sm placeholder-gray-600
                focus:outline-none focus:border-white/20 transition-colors"
            />
          </div>

          {/* Color palette */}
          <div className="flex flex-col gap-2">
            <label className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">
              Color
            </label>
            <div className="grid grid-cols-5 gap-2">
              {Object.entries(MIX_COLORS).map(([key, val]) => (
                <button
                  key={key}
                  onClick={() => setColor(key)}
                  title={key}
                  className="relative aspect-square rounded-lg transition-transform hover:scale-110 active:scale-95"
                  style={{ background: val.gradient }}
                >
                  {color === key && (
                    <span className="absolute inset-0 flex items-center justify-center text-white text-sm font-bold">
                      ✓
                    </span>
                  )}
                  <span
                    className="absolute inset-0 rounded-lg"
                    style={{
                      border:
                        color === key
                          ? `2px solid rgba(255,255,255,0.6)`
                          : `2px solid transparent`,
                    }}
                  />
                </button>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={onCancel}
              className="flex-1 py-2 rounded-lg text-sm text-gray-500 hover:text-gray-300
                bg-white/[0.04] hover:bg-white/[0.07] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!name.trim()}
              className="flex-1 py-2 rounded-lg text-sm font-semibold text-white
                disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              style={{
                background: name.trim() ? palette.gradient : undefined,
                backgroundColor: name.trim() ? undefined : "#334155",
              }}
            >
              Confirm
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── MergeMixModal ─────────────────────────────────────────────────────────

function MergeMixModal({
  currentMixId,
  currentMixName,
  mixes,
  onConfirm,
  onCancel,
}: {
  currentMixId: string;
  currentMixName: string;
  mixes: Mix[];
  onConfirm: (sourceMixId: string) => void;
  onCancel: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const others = mixes.filter((m) => m.id !== currentMixId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-sm mx-4 rounded-2xl bg-[#13131f] border border-white/[0.09] shadow-2xl overflow-hidden">
        <div className="p-5 flex flex-col gap-4">
          <div>
            <h2 className="text-white font-semibold text-sm">
              Merge into &ldquo;{currentMixName}&rdquo;
            </h2>
            <p className="text-gray-600 text-xs mt-1">
              All tracks from the selected mix will be added. Duplicates are
              skipped.
            </p>
          </div>

          {others.length === 0 ? (
            <p className="text-gray-600 text-sm text-center py-6">
              No other mixes to merge from.
            </p>
          ) : (
            <ul className="flex flex-col gap-1 max-h-64 overflow-y-auto -mx-1 px-1">
              {others.map((mix) => (
                <li key={mix.id}>
                  <button
                    onClick={() => setSelectedId(mix.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-left transition-colors ${
                      selectedId === mix.id
                        ? "bg-white/[0.10] text-white"
                        : "hover:bg-white/[0.05] text-gray-400"
                    }`}
                  >
                    <span
                      className="shrink-0 w-4 h-4 rounded-full"
                      style={{
                        background: (
                          MIX_COLORS[mix.color ?? DEFAULT_COLOR] ??
                          MIX_COLORS[DEFAULT_COLOR]
                        ).gradient,
                      }}
                    />
                    <span className="flex-1 truncate">{mix.name}</span>
                    <span className="text-[11px] text-gray-600">
                      {mix.trackIds.length} tracks
                    </span>
                    {selectedId === mix.id && (
                      <span className="text-purple-400 text-xs">✓</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={onCancel}
              className="flex-1 py-2 rounded-lg text-sm text-gray-500 hover:text-gray-300
                bg-white/[0.04] hover:bg-white/[0.07] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => selectedId && onConfirm(selectedId)}
              disabled={!selectedId || others.length === 0}
              className="flex-1 py-2 rounded-lg text-sm font-semibold text-white
                bg-purple-700 hover:bg-purple-600 disabled:opacity-30
                disabled:cursor-not-allowed transition-colors"
            >
              Merge
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── MixCard ───────────────────────────────────────────────────────────────

function MixCard({
  name,
  subtitle,
  color,
  accent,
  onClick,
}: {
  name: string;
  subtitle: string;
  color?: string;
  accent?: boolean;
  onClick: () => void;
}) {
  const palette = accent
    ? null
    : (MIX_COLORS[color ?? DEFAULT_COLOR] ?? MIX_COLORS[DEFAULT_COLOR]);

  const baseClass =
    "group relative flex flex-col justify-end p-4 rounded-2xl aspect-square text-left " +
    "transition-all duration-200 hover:scale-[1.03] active:scale-[0.98]";
  const accentExtra =
    "bg-gradient-to-br from-purple-700 via-purple-800 to-indigo-900 " +
    "border border-purple-500/30 shadow-lg shadow-purple-900/40";

  return (
    <button
      onClick={onClick}
      className={accent ? `${baseClass} ${accentExtra}` : baseClass}
      style={
        accent
          ? undefined
          : {
              background: palette!.gradient,
              border: `1px solid ${palette!.border}`,
            }
      }
    >
      <div className="absolute top-4 right-4 w-10 h-10 rounded-full opacity-20 group-hover:opacity-35 transition-opacity bg-white" />
      <p className="text-sm font-semibold leading-tight truncate pr-12 text-white">
        {name}
      </p>
      <p
        className="text-[11px] mt-1"
        style={{
          color: accent
            ? "rgba(196,181,253,0.7)"
            : (palette?.subtitleColor ?? "rgba(209,213,219,0.6)"),
        }}
      >
        {subtitle}
      </p>
    </button>
  );
}

function NewMixCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col items-center justify-center rounded-2xl aspect-square
        border-2 border-dashed border-white/[0.08] hover:border-purple-500/40
        text-gray-700 hover:text-purple-400 transition-all duration-200
        hover:scale-[1.03] active:scale-[0.98] hover:bg-purple-500/5"
    >
      <span className="text-3xl leading-none mb-1 group-hover:scale-110 transition-transform">
        +
      </span>
      <span className="text-[11px] font-medium">New Mix</span>
    </button>
  );
}

// ── MixGrid

function MixGrid({
  mixes,
  library,
  onOpenLibrary,
  onOpenMix,
  onCreateMix,
}: {
  mixes: Mix[];
  library: TrackMeta[];
  onOpenLibrary: () => void;
  onOpenMix: (id: string) => void;
  onCreateMix: () => void;
}) {
  const [sort, setSort] = useState<"recent" | "name" | "size">("recent");

  console.log("[MixGrid] render — mixes count:", mixes.length, mixes);

  const sortedMixes = [...mixes].sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "size") return b.trackIds.length - a.trackIds.length;
    return b.createdAt - a.createdAt;
  });

  const libDur = fmtTotal(
    library.map((t) => t.track_id),
    library,
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {mixes.length > 1 && (
        <div className="flex items-center gap-2 px-6 pt-4 pb-1 shrink-0">
          <span className="text-[10px] uppercase tracking-widest text-gray-600 font-semibold mr-1">
            Sort
          </span>
          {(["recent", "name", "size"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSort(s)}
              className={`px-2.5 py-1 rounded text-[11px] transition-colors ${
                sort === s
                  ? "bg-purple-600/30 text-purple-300"
                  : "text-gray-600 hover:text-gray-400"
              }`}
            >
              {s === "recent" ? "Recent" : s === "name" ? "Name" : "Size"}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-6 pb-6 pt-2">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          <MixCard
            name="Library"
            subtitle={`${library.length} track${library.length !== 1 ? "s" : ""}${libDur ? ` · ${libDur}` : ""}`}
            accent
            onClick={onOpenLibrary}
          />
          {sortedMixes.map((mix) => {
            const dur = fmtTotal(mix.trackIds, library);
            return (
              <MixCard
                key={mix.id}
                name={mix.name}
                subtitle={`${mix.trackIds.length} track${
                  mix.trackIds.length !== 1 ? "s" : ""
                }${dur ? ` · ${dur}` : ""}`}
                color={mix.color}
                onClick={() => onOpenMix(mix.id)}
              />
            );
          })}
          <NewMixCard onClick={onCreateMix} />
        </div>
      </div>
    </div>
  );
}

// ── MixEditor ─────────────────────────────────────────────────────────────

function MixEditor({
  mix,
  library,
  onBack,
  onUpdate,
  onDelete,
  onEditSettings,
  onDuplicate,
  onMerge,
}: {
  mix: Mix;
  library: TrackMeta[];
  onBack: () => void;
  onUpdate: (
    updates: Partial<Pick<Mix, "name" | "trackIds" | "color">>,
  ) => void;
  onDelete: () => void;
  onEditSettings: () => void;
  onDuplicate: () => void;
  onMerge: () => void;
}) {
  const [search, setSearch] = useState("");
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const palette =
    MIX_COLORS[mix.color ?? DEFAULT_COLOR] ?? MIX_COLORS[DEFAULT_COLOR];

  const mixTracks = mix.trackIds
    .map((id) => library.find((t) => t.track_id === id))
    .filter((t): t is TrackMeta => t != null);

  const inMixSet = new Set(mix.trackIds);

  const searchResults =
    search.trim().length > 0
      ? library
          .filter(
            (t) =>
              !inMixSet.has(t.track_id) &&
              t.track_id.toLowerCase().includes(search.toLowerCase()),
          )
          .slice(0, 40)
      : library.filter((t) => !inMixSet.has(t.track_id)).slice(0, 60);

  function addTrack(trackId: string) {
    onUpdate({ trackIds: [...mix.trackIds, trackId] });
  }

  function removeTrack(trackId: string) {
    onUpdate({ trackIds: mix.trackIds.filter((id) => id !== trackId) });
  }

  function handleDrop(toIndex: number) {
    const from = dragIndexRef.current;
    if (from === null || from === toIndex) return;
    const next = [...mix.trackIds];
    const [moved] = next.splice(from, 1);
    next.splice(toIndex, 0, moved);
    onUpdate({ trackIds: next });
    dragIndexRef.current = null;
    setDragOverIndex(null);
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-white/[0.06] shrink-0">
        <button
          onClick={onBack}
          className="text-gray-500 hover:text-gray-300 transition-colors text-sm flex items-center gap-1"
        >
          ← Mixes
        </button>

        {/* Color swatch + mix name + edit button */}
        <button
          onClick={onEditSettings}
          className="group flex items-center gap-2 min-w-0 flex-1"
          title="Edit name and color"
        >
          <span
            className="shrink-0 w-5 h-5 rounded-full shadow-md"
            style={{ background: palette.gradient }}
          />
          <span className="text-white font-semibold text-sm truncate">
            {mix.name}
          </span>
          <span className="text-[10px] text-gray-700 group-hover:text-gray-500 transition-colors">
            ✎
          </span>
        </button>

        <span className="text-gray-600 text-xs">
          {mix.trackIds.length} track{mix.trackIds.length !== 1 ? "s" : ""}
        </span>

        <button
          onClick={onDuplicate}
          className="text-gray-600 hover:text-gray-300 transition-colors text-xs"
          title="Duplicate this mix"
        >
          Duplicate
        </button>
        <button
          onClick={onMerge}
          className="text-gray-600 hover:text-gray-300 transition-colors text-xs"
          title="Merge another mix into this one"
        >
          Merge
        </button>

        <button
          onClick={() => {
            if (confirm(`Delete mix "${mix.name}"?`)) onDelete();
          }}
          className="text-gray-700 hover:text-red-400 transition-colors text-xs"
        >
          Delete mix
        </button>
      </div>

      <div className="flex flex-1 min-h-0 divide-x divide-white/[0.06]">
        {/* Mix track list */}
        <div className="flex flex-col flex-1 min-h-0 min-w-0">
          <div className="shrink-0 px-4 pt-3 pb-2 text-[10px] uppercase tracking-widest text-gray-600 font-semibold">
            Tracks in mix · drag to reorder
          </div>

          {mixTracks.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-gray-700 text-xs text-center px-8">
              No tracks yet — search on the right to add some.
            </div>
          ) : (
            <ul className="flex-1 overflow-y-auto divide-y divide-white/[0.04]">
              {mixTracks.map((track, i) => {
                const isDragOver = dragOverIndex === i;
                return (
                  <li
                    key={track.track_id}
                    draggable
                    onDragStart={() => {
                      dragIndexRef.current = i;
                    }}
                    onDragEnter={(e) => {
                      e.preventDefault();
                      setDragOverIndex(i);
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      handleDrop(i);
                    }}
                    onDragEnd={() => {
                      dragIndexRef.current = null;
                      setDragOverIndex(null);
                    }}
                    className={`flex items-center gap-2 px-4 py-2.5 group text-xs transition-colors
                      hover:bg-white/[0.03] cursor-grab active:cursor-grabbing
                      ${isDragOver ? "border-t-2 border-purple-400" : ""}`}
                  >
                    <span className="text-gray-700 group-hover:text-gray-500 select-none shrink-0">
                      ⠿
                    </span>
                    <span className="text-gray-500 tabular-nums w-6 shrink-0 text-right">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-gray-300 truncate">{track.track_id}</p>
                      <p className="text-gray-600 font-mono text-[10px]">
                        {track.tempo.toFixed(0)} BPM
                        {track.camelot ? ` · ${track.camelot}` : ""}
                        {" · "}
                        {fmt(track.duration)}
                      </p>
                    </div>
                    <button
                      onClick={() => removeTrack(track.track_id)}
                      className="shrink-0 text-gray-700 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 px-1"
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Search & add panel */}
        <div className="flex flex-col w-[30rem] shrink-0 min-h-0">
          <div className="shrink-0 px-4 pt-3 pb-2 text-[10px] uppercase tracking-widest text-gray-600 font-semibold">
            Add tracks
          </div>
          <div className="shrink-0 px-4 pb-3">
            <input
              type="search"
              placeholder="Search library…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-3 py-1.5 rounded-lg bg-white/[0.05] border border-white/[0.08]
                text-xs text-gray-300 placeholder-gray-600
                focus:outline-none focus:border-purple-500/50 focus:bg-white/[0.07]"
            />
          </div>
          <ul className="flex-1 overflow-y-auto divide-y divide-white/[0.04]">
            {searchResults.map((t) => (
              <li key={t.track_id}>
                <button
                  onClick={() => addTrack(t.track_id)}
                  className="w-full text-left px-4 py-2.5 text-xs hover:bg-white/[0.04] transition-colors group"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-gray-600 group-hover:text-purple-400 transition-colors shrink-0">
                      +
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-gray-400 group-hover:text-gray-200 truncate transition-colors">
                        {t.track_id}
                      </p>
                      <p className="text-gray-700 font-mono text-[10px]">
                        {t.tempo.toFixed(0)} BPM
                        {t.camelot ? ` · ${t.camelot}` : ""}
                        {" · "}
                        {fmt(t.duration)}
                      </p>
                    </div>
                  </div>
                </button>
              </li>
            ))}
            {searchResults.length === 0 && (
              <li className="px-4 py-3 text-xs text-gray-700 text-center">
                {search.trim().length > 0
                  ? "No matches in library"
                  : "All tracks already in mix"}
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ── LibraryManageView ─────────────────────────────────────────────────────

// ── TrackContextMenu ─────────────────────────────────────────────────────

function TrackContextMenu({
  trackId,
  x,
  y,
  onClose,
}: {
  trackId: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const { mixes, updateMix } = useMixes();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  // Adjust so menu stays inside viewport
  const menuW = 220;
  const menuH = 40 + mixes.length * 36;
  const left = x + menuW > window.innerWidth ? x - menuW : x;
  const top = y + menuH > window.innerHeight ? y - menuH : y;

  return (
    <div
      ref={ref}
      className="fixed z-[200] min-w-[200px] rounded-xl bg-[#151522] border border-white/[0.10]
        shadow-2xl py-1.5 overflow-hidden"
      style={{ left, top }}
    >
      <p className="px-3 py-1.5 text-[10px] uppercase tracking-widest text-gray-600 font-semibold">
        Add to mix
      </p>
      {mixes.length === 0 && (
        <p className="px-3 py-2 text-xs text-gray-600">No mixes yet</p>
      )}
      {mixes.map((mix) => {
        const alreadyIn = mix.trackIds.includes(trackId);
        return (
          <button
            key={mix.id}
            disabled={alreadyIn}
            onClick={() => {
              if (!alreadyIn) {
                updateMix(mix.id, { trackIds: [...mix.trackIds, trackId] });
              }
              onClose();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left
              disabled:opacity-40 disabled:cursor-not-allowed
              hover:bg-white/[0.05] transition-colors"
          >
            <span
              className="shrink-0 w-3 h-3 rounded-full"
              style={{
                background: (
                  MIX_COLORS[mix.color ?? DEFAULT_COLOR] ??
                  MIX_COLORS[DEFAULT_COLOR]
                ).gradient,
              }}
            />
            <span className={alreadyIn ? "text-gray-600" : "text-gray-300"}>
              {mix.name}
            </span>
            {alreadyIn && (
              <span className="ml-auto text-[10px] text-gray-700">added</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function LibraryManageView({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient();
  const { tracks: folderTracks } = useFolders();
  const [ctxMenu, setCtxMenu] = useState<{
    trackId: string;
    x: number;
    y: number;
  } | null>(null);

  const { data: library = [], isLoading: libLoading } = useQuery<TrackMeta[]>({
    queryKey: ["tracks"],
    queryFn: fetchTracks,
    staleTime: 0,
  });
  const { data: featureIds = [], isLoading: featLoading } = useQuery<string[]>({
    queryKey: ["featureIds"],
    queryFn: fetchFeatureIds,
    staleTime: 0,
  });

  const featureSet = new Set(featureIds);
  const localSet = new Set(
    folderTracks.map((t) => t.filename.replace(/\.mp3$/i, "")),
  );
  const orphaned = library.filter((t) => !localSet.has(t.track_id));

  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [purging, setPurging] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [lastPurge, setLastPurge] = useState<number | null>(null);

  async function handleDelete(trackId: string) {
    if (!confirm(`Delete "${trackId}" from your library?`)) return;
    setDeleting((s) => new Set(s).add(trackId));
    try {
      await deleteTrack(trackId);
      qc.invalidateQueries({ queryKey: ["tracks"] });
      qc.invalidateQueries({ queryKey: ["featureIds"] });
    } finally {
      setDeleting((s) => {
        const n = new Set(s);
        n.delete(trackId);
        return n;
      });
    }
  }

  async function handleClearAll() {
    if (
      !confirm(
        `Permanently delete ALL ${library.length} library entries and features? This cannot be undone.`,
      )
    )
      return;
    setClearing(true);
    try {
      const result = await clearAllTracks();
      setLastPurge(result.deleted);
      qc.invalidateQueries({ queryKey: ["tracks"] });
      qc.invalidateQueries({ queryKey: ["featureIds"] });
    } finally {
      setClearing(false);
    }
  }

  async function handlePurge() {
    if (localSet.size === 0) {
      alert("No local folder is linked.");
      return;
    }
    if (orphaned.length === 0) {
      alert("No orphaned tracks found.");
      return;
    }
    if (
      !confirm(
        `Delete ${orphaned.length} orphaned track${orphaned.length === 1 ? "" : "s"}?`,
      )
    )
      return;
    setPurging(true);
    try {
      const keepIds = library
        .filter((t) => localSet.has(t.track_id))
        .map((t) => t.track_id);
      const result = await purgeTracks(keepIds);
      setLastPurge(result.deleted);
      qc.invalidateQueries({ queryKey: ["tracks"] });
      qc.invalidateQueries({ queryKey: ["featureIds"] });
    } finally {
      setPurging(false);
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-white/[0.06] shrink-0">
        <button
          onClick={onBack}
          className="text-gray-500 hover:text-gray-300 transition-colors text-sm flex items-center gap-1"
        >
          ← Mixes
        </button>
        <span className="text-white font-semibold text-sm">Library</span>
        <div className="text-gray-600 text-xs ml-1">
          {library.length} track{library.length !== 1 ? "s" : ""}
          {featureIds.length > 0 && (
            <span className="ml-2">
              · {featureIds.length} with CLI features
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {lastPurge !== null && (
            <span className="text-xs text-green-500">
              Removed {lastPurge} entr{lastPurge !== 1 ? "ies" : "y"}
            </span>
          )}
          <button
            onClick={handleClearAll}
            disabled={clearing || library.length === 0}
            className="px-3 py-1.5 rounded bg-white/[0.04] border border-white/[0.07] text-xs text-gray-400
              hover:text-red-400 hover:border-red-500/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            {clearing ? "Clearing…" : "Clear all"}
          </button>
          <button
            onClick={handlePurge}
            disabled={purging || orphaned.length === 0}
            className="px-3 py-1.5 rounded bg-white/[0.04] border border-white/[0.07] text-xs text-gray-400
              hover:text-orange-400 hover:border-orange-500/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            {purging ? "Purging…" : `Purge orphaned (${orphaned.length})`}
          </button>
        </div>
      </div>

      {libLoading || featLoading ? (
        <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
          Loading…
        </div>
      ) : library.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-gray-600">
          <p className="text-sm">Your library is empty.</p>
          <p className="text-xs text-gray-700">
            Run{" "}
            <code className="text-purple-400">
              beatbot extract &lt;folder&gt;
            </code>{" "}
            to upload features.
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4">
          <div className="rounded-lg border border-white/[0.06] overflow-hidden">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-[#0d0d1a] border-b border-white/[0.06]">
                  <th className="text-left px-4 py-2.5 text-gray-500 font-medium text-xs uppercase tracking-wide">
                    Track
                  </th>
                  <th className="text-right px-4 py-2.5 text-gray-500 font-medium text-xs uppercase tracking-wide w-16">
                    BPM
                  </th>
                  <th className="text-right px-4 py-2.5 text-gray-500 font-medium text-xs uppercase tracking-wide w-20">
                    Duration
                  </th>
                  <th className="text-center px-4 py-2.5 text-gray-500 font-medium text-xs uppercase tracking-wide w-20">
                    Status
                  </th>
                  <th className="w-14" />
                </tr>
              </thead>
              <tbody>
                {library.map((track) => {
                  const hasCli = featureSet.has(track.track_id);
                  const isOrphaned =
                    !localSet.has(track.track_id) && localSet.size > 0;
                  const isDel = deleting.has(track.track_id);
                  return (
                    <tr
                      key={track.track_id}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setCtxMenu({
                          trackId: track.track_id,
                          x: e.clientX,
                          y: e.clientY,
                        });
                      }}
                      className={`border-b border-white/[0.03] transition-colors cursor-context-menu ${isOrphaned ? "bg-orange-500/[0.03]" : "hover:bg-white/[0.02]"}`}
                    >
                      <td className="px-4 py-2.5 text-gray-300 font-medium truncate max-w-0 w-full">
                        <div className="flex items-center gap-2 truncate">
                          <span className="truncate">{track.track_id}</span>
                          {isOrphaned && (
                            <span className="shrink-0 text-[10px] text-orange-500/70 font-normal">
                              not in folder
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-500 tabular-nums">
                        {track.tempo > 0 ? track.tempo.toFixed(1) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-500 tabular-nums">
                        {fmt(track.duration)}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {hasCli ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide text-purple-400 bg-purple-500/10">
                            CLI
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide text-gray-600 bg-white/[0.03]">
                            no data
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <button
                          onClick={() => handleDelete(track.track_id)}
                          disabled={isDel}
                          className="text-gray-700 hover:text-red-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-xs"
                        >
                          {isDel ? "…" : "✕"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {ctxMenu && (
        <TrackContextMenu
          trackId={ctxMenu.trackId}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

// ── Library (root) ────────────────────────────────────────────────────────

type View = "grid" | "manage" | "mix";

type ModalIntent =
  | { mode: "new" }
  | { mode: "edit"; mixId: string }
  | { mode: "merge"; mixId: string };

export default function Library() {
  const { mixes, createMix, updateMix, deleteMix, duplicateMix } = useMixes();
  const [view, setView] = useState<View>("grid");
  const [activeMixId, setActiveMixId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalIntent | null>(null);

  const { data: library = [] } = useQuery<TrackMeta[]>({
    queryKey: ["tracks"],
    queryFn: fetchTracks,
    staleTime: 0,
  });

  function openMix(id: string) {
    setActiveMixId(id);
    setView("mix");
  }

  function handleDeleteMix(id: string) {
    deleteMix(id);
    setView("grid");
    setActiveMixId(null);
  }

  const activeMix = mixes.find((m) => m.id === activeMixId);

  function handleModalConfirm({
    name,
    color,
  }: {
    name: string;
    color: string;
  }) {
    if (!modal) return;
    if (modal.mode === "new") {
      const mix = createMix(name, color);
      setModal(null);
      openMix(mix.id);
    } else if (modal.mode === "edit") {
      updateMix(modal.mixId, { name, color });
      setModal(null);
    }
  }

  function handleMergeConfirm(sourceMixId: string) {
    if (!modal || modal.mode !== "merge") return;
    const source = mixes.find((m) => m.id === sourceMixId);
    const target = mixes.find((m) => m.id === modal.mixId);
    if (!source || !target) return;
    const merged = [
      ...target.trackIds,
      ...source.trackIds.filter((id) => !target.trackIds.includes(id)),
    ];
    updateMix(modal.mixId, { trackIds: merged });
    setModal(null);
  }

  const modalInitial =
    modal?.mode === "edit"
      ? {
          name: mixes.find((m) => m.id === modal.mixId)?.name ?? "",
          color:
            mixes.find((m) => m.id === modal.mixId)?.color ?? DEFAULT_COLOR,
        }
      : { name: "", color: DEFAULT_COLOR };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {modal && modal.mode !== "merge" && (
        <MixSetupModal
          initial={modalInitial}
          onConfirm={handleModalConfirm}
          onCancel={() => setModal(null)}
        />
      )}
      {modal?.mode === "merge" && activeMix && (
        <MergeMixModal
          currentMixId={activeMix.id}
          currentMixName={activeMix.name}
          mixes={mixes}
          onConfirm={handleMergeConfirm}
          onCancel={() => setModal(null)}
        />
      )}

      {view === "grid" && (
        <MixGrid
          mixes={mixes}
          library={library}
          onOpenLibrary={() => setView("manage")}
          onOpenMix={openMix}
          onCreateMix={() => setModal({ mode: "new" })}
        />
      )}
      {view === "manage" && (
        <LibraryManageView onBack={() => setView("grid")} />
      )}
      {view === "mix" && activeMix && (
        <MixEditor
          mix={activeMix}
          library={library}
          onBack={() => setView("grid")}
          onUpdate={(updates) => updateMix(activeMix.id, updates)}
          onDelete={() => handleDeleteMix(activeMix.id)}
          onEditSettings={() => setModal({ mode: "edit", mixId: activeMix.id })}
          onDuplicate={() => {
            const copy = duplicateMix(activeMix.id);
            openMix(copy.id);
          }}
          onMerge={() => setModal({ mode: "merge", mixId: activeMix.id })}
        />
      )}
    </div>
  );
}
