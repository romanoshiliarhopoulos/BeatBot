/**
 * Discover — YouTube search + one-click import via the beatbot daemon.
 *
 * Requires the local sidecar to be running:
 *   beatbot daemon
 *
 * Or install as a macOS login item (starts automatically):
 *   beatbot daemon --autostart
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { fetchTracks } from "../api/client";
import type { TrackMeta } from "../types";
import {
  daemonHealth,
  daemonSearch,
  daemonImport,
  daemonGetConfig,
  daemonSetMusicDir,
  connectDaemonWS,
  fmtDuration,
  type SearchResult,
  type ImportProgress,
} from "../api/daemonClient";

// ── helpers ────────────────────────────────────────────────────────────────

/** Mirror the sanitisation logic in daemon.py so we can derive the track_id. */
function toTrackId(title: string): string {
  // eslint-disable-next-line no-control-regex
  return title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .trim()
    .slice(0, 100);
}

function importLabel(s: ImportProgress): string {
  switch (s.status) {
    case "queued":
      return "Queued…";
    case "downloading":
      return s.progress != null ? `Downloading ${s.progress}%` : "Downloading…";
    case "extracting":
      return "Extracting…";
    case "uploading":
      return "Uploading…";
    case "done":
      return "✓ Imported";
    case "error":
      return "✗ Error";
    default:
      return s.status;
  }
}

const ACTIVE_STATUSES = new Set<string>([
  "queued",
  "downloading",
  "extracting",
  "uploading",
]);

// ── OfflinePane ────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="ml-2 px-2 py-0.5 rounded text-[11px] border border-white/10
        text-gray-400 hover:text-white hover:border-white/20 transition-colors"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function CodeLine({ cmd }: { cmd: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-black/40 border border-white/10 font-mono text-sm text-purple-300 w-full">
      <span className="text-gray-600 select-none">$</span>
      <span className="flex-1 text-left">{cmd}</span>
      <CopyButton text={cmd} />
    </div>
  );
}

function OfflinePane({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-6 px-8 text-center">
      {/* Icon */}
      <div
        className="w-16 h-16 rounded-2xl bg-white/[0.03] border border-white/[0.07]
        flex items-center justify-center text-3xl"
      >
        🎵
      </div>

      <div>
        <h2 className="text-lg font-semibold text-white mb-2">
          BeatBot Daemon not running
        </h2>
        <p className="text-sm text-gray-400 max-w-md leading-relaxed">
          The Discover page needs a small local helper that runs on your machine
          to download and analyse audio. Open a terminal and run:
        </p>
      </div>

      <div className="w-full max-w-md space-y-3">
        <CodeLine cmd="beatbot daemon" />

        <p className="text-xs text-gray-600 py-1">
          Or install it as a macOS login item — starts automatically every time
          you log in:
        </p>
        <CodeLine cmd="beatbot daemon --autostart" />
      </div>

      <button
        onClick={onRetry}
        className="px-4 py-2 rounded-lg text-sm bg-purple-600 hover:bg-purple-500
          text-white transition-colors"
      >
        Check again
      </button>

      <p className="text-[11px] text-gray-700 max-w-sm">
        The daemon only listens on&nbsp;127.0.0.1 — it is never exposed to the
        internet. Music files are saved to&nbsp;~/Music/BeatBot by default.
      </p>
    </div>
  );
}

// ── ResultCard ─────────────────────────────────────────────────────────────

interface CardProps {
  result: SearchResult;
  importState: ImportProgress | undefined;
  inLibrary: boolean;
  onImport: (r: SearchResult) => void;
  onPlay: (r: SearchResult) => void;
}

function ResultCard({
  result,
  importState,
  inLibrary,
  onImport,
  onPlay,
}: CardProps) {
  const isActive = importState && ACTIVE_STATUSES.has(importState.status);
  const isDone = importState?.status === "done" || inLibrary;
  const isError = importState?.status === "error";
  const progress =
    importState?.status === "downloading" ? (importState.progress ?? 0) : 0;

  return (
    <div
      className="flex flex-col rounded-lg overflow-hidden border border-white/[0.07]
        bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
    >
      {/* Thumbnail — click to play */}
      <div
        className="group relative aspect-video bg-black/40 overflow-hidden cursor-pointer"
        onClick={() => onPlay(result)}
      >
        {result.thumbnail ? (
          <img
            src={result.thumbnail}
            alt={result.title}
            loading="lazy"
            className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-2xl text-gray-700">
            ♪
          </div>
        )}

        {/* Hover play button */}
        {!isActive && (
          <div
            className="absolute inset-0 flex items-center justify-center
            bg-black/0 group-hover:bg-black/40 transition-all duration-200"
          >
            <div
              className="opacity-0 group-hover:opacity-100 transition-opacity duration-200
              w-9 h-9 rounded-full bg-white/20 backdrop-blur-sm border border-white/30
              flex items-center justify-center"
            >
              <svg
                className="w-4 h-4 text-white ml-0.5"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        )}

        {/* Duration badge */}
        {result.duration > 0 && (
          <span
            className="absolute bottom-1 right-1.5 text-[10px] font-mono
            bg-black/70 text-white px-1 py-0.5 rounded"
          >
            {fmtDuration(result.duration)}
          </span>
        )}
        {/* Active overlay */}
        {isActive && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <Spinner />
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex flex-col flex-1 p-2 gap-1.5">
        <p className="text-[11px] font-medium text-white leading-snug line-clamp-2 min-h-[2.2rem]">
          {result.title}
        </p>
        {result.channel && (
          <p className="text-[10px] text-gray-600 truncate">{result.channel}</p>
        )}

        {/* Progress bar */}
        {importState?.status === "downloading" && (
          <div className="w-full h-0.5 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full rounded-full bg-purple-500 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {/* Status / Import button */}
        <div className="mt-auto pt-0.5">
          {isDone ? (
            <div className="text-[11px] text-green-400 font-medium text-center py-1">
              ✓ {inLibrary && !importState ? "In Library" : "Imported"}
            </div>
          ) : isError ? (
            <div className="text-[10px] text-red-400 text-center py-0.5 space-y-0.5">
              <div>✗ Error</div>
              {importState?.message && (
                <div className="text-[9px] text-red-300/70 leading-snug break-words">
                  {importState.message}
                </div>
              )}
            </div>
          ) : isActive ? (
            <div className="text-[10px] text-purple-300 text-center py-1 animate-pulse">
              {importLabel(importState!)}
            </div>
          ) : (
            <button
              onClick={() => onImport(result)}
              className="w-full py-1 rounded-md text-[11px] font-medium transition-colors
                bg-purple-600/80 hover:bg-purple-500 text-white"
            >
              Import
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── VideoModal ────────────────────────────────────────────────────────────

function VideoModal({
  video,
  onClose,
}: {
  video: SearchResult;
  onClose: () => void;
}) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl mx-4 rounded-xl overflow-hidden
          border border-white/10 shadow-2xl bg-[#0d0d0d]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.07]">
          <p className="text-xs font-medium text-white truncate pr-3">
            {video.title}
          </p>
          <button
            onClick={onClose}
            className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center
              text-gray-400 hover:text-white hover:bg-white/10 transition-colors text-sm"
          >
            ✕
          </button>
        </div>
        {/* YouTube embed — includes native seekbar */}
        <div className="aspect-video">
          <iframe
            src={`https://www.youtube.com/embed/${video.video_id}?autoplay=1&rel=0`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            className="w-full h-full"
            title={video.title}
          />
        </div>
        {/* Footer: channel + open in YouTube */}
        <div className="flex items-center justify-between px-3 py-2 border-t border-white/[0.07]">
          {video.channel && (
            <span className="text-[11px] text-gray-500">{video.channel}</span>
          )}
          <a
            href={`https://www.youtube.com/watch?v=${video.video_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-[11px] text-purple-400 hover:text-purple-300 transition-colors"
          >
            Open in YouTube ↗
          </a>
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="w-6 h-6 text-purple-400 animate-spin"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

// ── MusicDirBar ────────────────────────────────────────────────────────────

function MusicDirBar({
  dir,
  onSave,
}: {
  dir: string;
  onSave: (d: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(dir);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setVal(dir);
  }, [dir]);

  async function save() {
    setBusy(true);
    await onSave(val);
    setBusy(false);
    setEditing(false);
  }

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="flex items-center gap-1.5 text-[11px] text-gray-600
          hover:text-gray-400 transition-colors truncate max-w-xs"
        title="Click to change music directory"
      >
        <span>📁</span>
        <span className="truncate">{dir || "~/Music/BeatBot"}</span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        className="text-[11px] bg-white/[0.06] border border-white/10 rounded px-2 py-1
          text-white w-56 outline-none focus:border-purple-500/50"
      />
      <button
        onClick={save}
        disabled={busy}
        className="text-[11px] px-2 py-1 rounded bg-purple-600 text-white
          hover:bg-purple-500 disabled:opacity-50 transition-colors"
      >
        {busy ? "Saving…" : "Save"}
      </button>
      <button
        onClick={() => setEditing(false)}
        className="text-[11px] text-gray-500 hover:text-gray-300"
      >
        Cancel
      </button>
    </div>
  );
}

// ── ActiveImportsBadge ─────────────────────────────────────────────────────

function ActiveImportsBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full
      bg-purple-600/20 border border-purple-500/30 text-purple-300 text-[11px]"
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
      {count} importing
    </span>
  );
}

// ── Discover (main) ────────────────────────────────────────────────────────

export default function Discover() {
  const queryClient = useQueryClient();
  const { data: library = [] } = useQuery<TrackMeta[]>({
    queryKey: ["tracks"],
    queryFn: fetchTracks,
    staleTime: 60_000,
  });

  // Set of track_ids already in the cloud library
  const libraryIds = new Set(library.map((t) => t.track_id));

  // ── daemon health ──────────────────────────────────────────────────────
  const [daemonAlive, setDaemonAlive] = useState<boolean | null>(null);
  const healthPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkHealth = useCallback(async () => {
    const alive = await daemonHealth();
    setDaemonAlive(alive);
    if (!alive) {
      healthPollRef.current = setTimeout(checkHealth, 3000);
    }
  }, []);

  useEffect(() => {
    checkHealth();
    return () => {
      if (healthPollRef.current) clearTimeout(healthPollRef.current);
    };
  }, [checkHealth]);

  // When daemon comes alive, start polling for reconnects more slowly.
  useEffect(() => {
    if (!daemonAlive) return;
    // Periodically verify the daemon hasn't stopped.
    const interval = setInterval(async () => {
      const alive = await daemonHealth();
      if (!alive) {
        setDaemonAlive(false);
        checkHealth();
      }
    }, 10_000);
    return () => clearInterval(interval);
  }, [daemonAlive, checkHealth]);

  // ── WebSocket ──────────────────────────────────────────────────────────
  const [importStates, setImportStates] = useState<
    Record<string, ImportProgress>
  >({});
  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    if (!daemonAlive) return;
    const cleanup = connectDaemonWS((msg) => {
      console.log("[Discover] WS message:", msg);
      setImportStates((prev) => ({ ...prev, [msg.track_id]: msg }));
      if (msg.status === "done") {
        console.log(
          "[Discover] Import done for",
          msg.track_id,
          "— refreshing library",
        );
        // Refresh library so the imported track appears immediately.
        queryClient.invalidateQueries({ queryKey: ["tracks"] });
      }
      if (msg.status === "error") {
        console.error(
          "[Discover] Import error for",
          msg.track_id,
          ":",
          msg.message,
        );
      }
    }, setWsConnected);
    return cleanup;
  }, [daemonAlive, queryClient]);

  // ── config ─────────────────────────────────────────────────────────────
  const [musicDir, setMusicDir] = useState("");

  useEffect(() => {
    if (!daemonAlive) return;
    daemonGetConfig()
      .then((c) => setMusicDir(c.music_dir))
      .catch(() => {});
  }, [daemonAlive]);

  const handleSaveDir = useCallback(async (dir: string) => {
    await daemonSetMusicDir(dir);
    setMusicDir(dir);
  }, []);

  // ── search ─────────────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    if (!query.trim() || !daemonAlive) {
      setResults([]);
      setSearchError(null);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const res = await daemonSearch(query);
        setResults(res);
      } catch (e: unknown) {
        setSearchError(e instanceof Error ? e.message : "Search failed");
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [query, daemonAlive]);

  // ── import ─────────────────────────────────────────────────────────────
  const handleImport = useCallback(async (result: SearchResult) => {
    const trackId = toTrackId(result.title) || result.video_id;
    console.log("[Discover] Starting import:", {
      video_id: result.video_id,
      title: result.title,
      trackId,
    });
    // Optimistically set "queued" before the WS event arrives.
    setImportStates((prev) => ({
      ...prev,
      [trackId]: {
        type: "import_progress",
        track_id: trackId,
        status: "queued",
      },
    }));
    try {
      const resp = await daemonImport(result.video_id, result.title);
      console.log("[Discover] daemonImport response:", resp);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Request failed";
      console.error("[Discover] daemonImport FAILED:", e);
      setImportStates((prev) => ({
        ...prev,
        [trackId]: {
          type: "import_progress",
          track_id: trackId,
          status: "error",
          message: msg,
        },
      }));
    }
  }, []);

  // ── video player ────────────────────────────────────────────────────────
  const [activeVideo, setActiveVideo] = useState<SearchResult | null>(null);

  // ── derived ─────────────────────────────────────────────────────────────
  const activeCount = Object.values(importStates).filter((s) =>
    ACTIVE_STATUSES.has(s.status),
  ).length;

  // ── render: loading / offline ────────────────────────────────────────
  if (daemonAlive === null) {
    return (
      <div className="flex flex-col flex-1 items-center justify-center gap-3 text-gray-500">
        <Spinner />
        <span className="text-sm">Checking for daemon…</span>
      </div>
    );
  }

  if (!daemonAlive) {
    return <OfflinePane onRetry={checkHealth} />;
  }

  // ── render: online ───────────────────────────────────────────────────
  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* ── toolbar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-white/[0.05] shrink-0">
        {/* Search input */}
        <div className="relative flex-1 max-w-xl">
          <input
            autoFocus
            type="text"
            placeholder="Search YouTube…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-white/[0.05] border border-white/10 rounded-lg
              pl-9 pr-4 py-2 text-sm text-white placeholder-gray-600
              outline-none focus:border-purple-500/50 transition-colors"
          />
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 text-sm">
            {searching ? (
              <svg
                className="w-4 h-4 animate-spin text-purple-400"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            ) : (
              "🔍"
            )}
          </span>
        </div>

        <ActiveImportsBadge count={activeCount} />

        <div className="ml-auto flex items-center gap-3">
          {/* WS status dot */}
          <span
            className={`text-[10px] flex items-center gap-1 ${wsConnected ? "text-green-600" : "text-gray-700"}`}
            title={wsConnected ? "Daemon connected" : "Daemon connecting…"}
          >
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${wsConnected ? "bg-green-500" : "bg-gray-600"}`}
            />
          </span>
          <MusicDirBar dir={musicDir} onSave={handleSaveDir} />
        </div>
      </div>

      {/* ── content ──────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {/* Error state */}
        {searchError && (
          <div
            className="text-sm text-red-400 bg-red-900/20 border border-red-800/30
            rounded-lg px-4 py-3 mb-4"
          >
            {searchError}
          </div>
        )}

        {/* Empty / prompt state */}
        {!results.length && !searching && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center py-20">
            {query.trim() ? (
              <p className="text-sm text-gray-600">No results for "{query}"</p>
            ) : (
              <>
                <p className="text-2xl">🎧</p>
                <p className="text-sm text-gray-500">
                  Search for a track to import into your library.
                </p>
                <p className="text-xs text-gray-700 max-w-xs leading-relaxed">
                  BeatBot will download the audio, extract features locally, and
                  upload them to your cloud library — all in one click.
                </p>
              </>
            )}
          </div>
        )}

        {/* Results grid */}
        {results.length > 0 && (
          <div className="grid grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
            {results.map((r) => {
              const trackId = toTrackId(r.title) || r.video_id;
              return (
                <ResultCard
                  key={r.video_id}
                  result={r}
                  importState={importStates[trackId]}
                  inLibrary={libraryIds.has(trackId)}
                  onImport={handleImport}
                  onPlay={setActiveVideo}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Video player modal */}
      {activeVideo && (
        <VideoModal video={activeVideo} onClose={() => setActiveVideo(null)} />
      )}
    </div>
  );
}
