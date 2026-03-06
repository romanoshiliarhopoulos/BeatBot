/**
 * Library — manage uploaded tracks.
 *
 * Shows every track stored in the user's Firestore library alongside a "CLI"
 * badge for tracks that have features uploaded via `beatbot extract`.
 *
 * Actions:
 *   • Delete individual tracks (removes library entry + stored features)
 *   • Purge orphaned tracks — removes every Firestore track whose filename
 *     does NOT match any file currently found in the user's local music folder
 */
import { useState } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";

import type { TrackMeta } from "../types";
import {
  fetchTracks,
  fetchFeatureIds,
  deleteTrack,
  purgeTracks,
  clearAllTracks,
} from "../api/client";
import { useFolders } from "../contexts/FolderContext";

// ── helpers ──────────────────────────────────────────────────────────────────

function fmt(secs: number): string {
  if (!secs) return "—";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── sub-components ────────────────────────────────────────────────────────────

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${color}`}
    >
      {label}
    </span>
  );
}

// ── Library ───────────────────────────────────────────────────────────────────

export default function Library() {
  const qc = useQueryClient();
  const { tracks: folderTracks } = useFolders();

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

  // Local filenames (without .mp3) present in scanned folders
  const localSet = new Set(
    folderTracks.map((t) => t.filename.replace(/\.mp3$/i, "")),
  );

  const orphaned = library.filter((t) => !localSet.has(t.track_id));

  // ── deletion state ──────────────────────────────────────────────────────────
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
        `This will permanently delete ALL ${library.length} library entries and all uploaded features. ` +
          `You will need to re-run \`beatbot extract\` to restore them. Continue?`,
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
      alert(
        "No local folder is linked — can't determine which tracks are orphaned.",
      );
      return;
    }
    if (orphaned.length === 0) {
      alert(
        "No orphaned tracks found — all library entries match your local folder.",
      );
      return;
    }
    if (
      !confirm(
        `This will delete ${orphaned.length} track${orphaned.length === 1 ? "" : "s"} ` +
          `that are in your library but not in your local folder. Continue?`,
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

  const loading = libLoading || featLoading;

  // ── render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
        Loading library…
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 p-6 gap-4">
      {/* ── toolbar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="text-gray-500 text-sm">
          {library.length} track{library.length !== 1 ? "s" : ""} in library
          {featureIds.length > 0 && (
            <span className="text-gray-600 ml-2">
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
            className="px-3 py-1.5 rounded bg-white/[0.04] border border-white/[0.07]
                       text-xs text-gray-400 hover:text-red-400 hover:border-red-500/30
                       disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Delete everything and start fresh"
          >
            {clearing ? "Clearing…" : "Clear all"}
          </button>
          <button
            onClick={handlePurge}
            disabled={purging || orphaned.length === 0}
            className="px-3 py-1.5 rounded bg-white/[0.04] border border-white/[0.07]
                       text-xs text-gray-400 hover:text-orange-400 hover:border-orange-500/30
                       disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title={
              orphaned.length === 0
                ? "No orphaned tracks"
                : `Remove ${orphaned.length} track${orphaned.length !== 1 ? "s" : ""} not in local folder`
            }
          >
            {purging ? "Purging…" : `Purge orphaned (${orphaned.length})`}
          </button>
        </div>
      </div>

      {/* ── table ────────────────────────────────────────────────────────── */}
      {library.length === 0 ? (
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
        <div className="flex-1 overflow-y-auto rounded-lg border border-white/[0.06] min-h-0">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="sticky top-0 bg-[#0d0d1a] border-b border-white/[0.06]">
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
                const isLocal = localSet.has(track.track_id);
                const isOrphaned = !isLocal && localSet.size > 0;
                const isDel = deleting.has(track.track_id);
                return (
                  <tr
                    key={track.track_id}
                    className={`border-b border-white/[0.03] transition-colors
                      ${isOrphaned ? "bg-orange-500/[0.03]" : "hover:bg-white/[0.02]"}`}
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
                        <Badge
                          label="CLI"
                          color="text-purple-400 bg-purple-500/10"
                        />
                      ) : (
                        <Badge
                          label="no data"
                          color="text-gray-600 bg-white/[0.03]"
                        />
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <button
                        onClick={() => handleDelete(track.track_id)}
                        disabled={isDel}
                        className="text-gray-700 hover:text-red-400 transition-colors
                                   disabled:opacity-40 disabled:cursor-not-allowed text-xs"
                        title="Remove from library"
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
      )}
    </div>
  );
}
