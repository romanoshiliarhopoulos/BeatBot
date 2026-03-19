import { useState, useCallback } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { fetchTracks, searchYoutube, uploadYoutube } from "../api/client";
import type { TrackMeta } from "../types";

export interface SearchResult {
  video_id: string
  title: string
  channel: string
  duration: number   // seconds
  thumbnail: string
  url: string
}

export type ImportStatus =
  | "queued"
  | "downloading"
  | "extracting"
  | "uploading"
  | "done"
  | "error"

export interface ImportProgress {
  type: "import_progress"
  track_id: string
  status: ImportStatus
  progress?: number    // 0-100, only during "downloading"
  message?: string     // error detail
}

function toTrackId(title: string): string {
  // eslint-disable-next-line no-control-regex
  return title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .trim()
    .slice(0, 100);
}

function importLabel(s: ImportProgress): string {
  switch (s.status) {
    case "queued": return "Queued…";
    case "downloading": return s.progress != null ? `Downloading ${s.progress}%` : "Downloading…";
    case "extracting": return "Extracting…";
    case "uploading": return "Uploading…";
    case "done": return "✓ Imported";
    case "error": return "✗ Error";
    default: return s.status;
  }
}

const ACTIVE_STATUSES = new Set<string>(["queued", "downloading", "extracting", "uploading"]);

function fmtDuration(secs: number): string {
  if (!secs) return "—"
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${s.toString().padStart(2, "0")}`
}

export default function Discover() {
  const queryClient = useQueryClient();
  const { data: library = [] } = useQuery<TrackMeta[]>({
    queryKey: ["tracks"],
    queryFn: fetchTracks,
    staleTime: 60_000,
  });

  const libraryIds = new Set(library.map((t) => t.track_id));
  const [importStates, setImportStates] = useState<Record<string, ImportProgress>>({});

  const [query, setQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [playingVideo, setPlayingVideo] = useState<SearchResult | null>(null);

  const handleSearch = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q) return;

    setIsSearching(true);
    try {
      const res = await searchYoutube(q);
      const mapped = res.map((r: any) => ({
        video_id: r.video_id,
        title: r.title,
        channel: r.channel || "",
        duration: r.duration || 0,
        thumbnail: `https://i.ytimg.com/vi/${r.video_id}/mqdefault.jpg`,
        url: r.url
      }));
      setResults(mapped);
    } catch (err) {
      console.error(err);
      alert("Search failed or YouTube blocked the request.");
    } finally {
      setIsSearching(false);
    }
  }, [query]);

  const handleImport = useCallback(async (r: SearchResult) => {
    const trackId = toTrackId(r.title) || r.video_id;

    if (libraryIds.has(trackId)) return;

    setImportStates(prev => ({
      ...prev,
      [trackId]: { type: "import_progress", track_id: trackId, status: "extracting" }
    }));

    try {
      const blob = await uploadYoutube(r.video_id, r.title);

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${trackId}.mp3`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);

      queryClient.invalidateQueries({ queryKey: ["tracks"] });

      setImportStates(prev => ({
        ...prev,
        [trackId]: { type: "import_progress", track_id: trackId, status: "done" }
      }));
    } catch (err: any) {
      console.error(err);
      setImportStates(prev => ({
        ...prev,
        [trackId]: { type: "import_progress", track_id: trackId, status: "error", message: err.message ?? "Unknown error" }
      }));
    }
  }, [libraryIds, queryClient]);

  function Spinner() {
    return (
      <svg className="w-6 h-6 text-purple-400 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
    );
  }

  function ResultCard({ result, importState, inLibrary, onImport, onPlay }: any) {
    const isActive = importState && ACTIVE_STATUSES.has(importState.status);
    const isDone = importState?.status === "done" || inLibrary;
    const isError = importState?.status === "error";
    const progress = importState?.status === "downloading" ? (importState.progress ?? 0) : 0;

    return (
      <div className="flex flex-col rounded-lg overflow-hidden border border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
        <div className="group relative aspect-video bg-black/40 overflow-hidden cursor-pointer" onClick={() => onPlay(result)}>
          {result.thumbnail ? (
            <img src={result.thumbnail} alt={result.title} loading="lazy" className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-2xl text-gray-700">♪</div>
          )}
          {!isActive && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-all duration-200">
              <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 w-9 h-9 rounded-full bg-white/20 backdrop-blur-sm border border-white/30 flex items-center justify-center">
                <svg className="w-4 h-4 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              </div>
            </div>
          )}
          {result.duration > 0 && (
            <span className="absolute bottom-1 right-1.5 text-[10px] font-mono bg-black/70 text-white px-1 py-0.5 rounded">{fmtDuration(result.duration)}</span>
          )}
          {isActive && (
            <div className="absolute inset-0 bg-black/50 flex items-center justify-center"><Spinner /></div>
          )}
        </div>

        <div className="flex flex-col flex-1 p-2 gap-1.5">
          <p className="text-[11px] font-medium text-white leading-snug line-clamp-2 min-h-[2.2rem]">{result.title}</p>
          {result.channel && <p className="text-[10px] text-gray-600 truncate">{result.channel}</p>}
          {importState?.status === "downloading" && (
            <div className="w-full h-0.5 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full rounded-full bg-purple-500 transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
          )}
          <div className="mt-auto pt-0.5">
            {isDone ? (
              <div className="text-[11px] text-green-400 font-medium text-center py-1">✓ {inLibrary && !importState ? "In Library" : "Imported"}</div>
            ) : isError ? (
              <div className="text-[10px] text-red-400 text-center py-1 truncate" title={importState.message}>✗ {importState.message || "Failed"}</div>
            ) : isActive ? (
              <div className="text-[11px] text-purple-400 font-medium text-center py-1 animate-pulse">{importLabel(importState)}</div>
            ) : (
              <button onClick={(e) => { e.stopPropagation(); onImport(result); }} className="w-full py-1 rounded bg-white/5 hover:bg-purple-600 hover:text-white border border-white/10 hover:border-purple-500 transition-all text-[11px] text-gray-300">
                Download & Import
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  function EmbeddedPlayer({ video, onClose }: any) {
    const ytUrl = `https://www.youtube.com/watch?v=${video.video_id}`;
    const embedSrc = `https://www.youtube.com/embed/${video.video_id}?autoplay=1`;

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm" onClick={onClose}>
        <div className="relative w-full max-w-2xl mx-4 rounded-xl overflow-hidden border border-white/10 shadow-2xl bg-[#0d0d0d]" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.07]">
            <p className="text-xs font-medium text-white truncate pr-3">{video.title}</p>
            <button onClick={onClose} className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition-colors text-sm">✕</button>
          </div>
          <div className="aspect-video">
            <iframe src={embedSrc} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen className="w-full h-full" title={video.title} />
          </div>
          <div className="flex items-center justify-between px-3 py-2 border-t border-white/[0.07]">
            {video.channel && <span className="text-[11px] text-gray-500">{video.channel}</span>}
            <a href={ytUrl} target="_blank" rel="noopener noreferrer" className="ml-auto text-[11px] text-purple-400 hover:text-purple-300 transition-colors">Open in YouTube ↗</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 pl-4 pb-4 bg-transparent max-h-full overflow-hidden">
      {playingVideo && <EmbeddedPlayer video={playingVideo} onClose={() => setPlayingVideo(null)} />}
      <div className="flex flex-col flex-1 min-h-0 min-w-0 pr-4 mt-4">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-white/5 shrink-0">
          <div className="flex-1 max-w-xl">
            <form onSubmit={handleSearch} className="relative group">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-500 group-focus-within:text-purple-400 transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <input type="text" placeholder="Search YouTube to download..." value={query} onChange={(e) => setQuery(e.target.value)} className="w-full bg-white/[0.03] border border-white/[0.07] rounded-lg pl-9 pr-24 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-purple-500/50 focus:bg-white/[0.05] transition-all" />
              <button type="submit" disabled={isSearching || !query.trim()} className="absolute inset-y-1.5 right-1.5 px-3 rounded text-[10px] font-medium text-white transition-colors flex items-center bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:hover:bg-purple-600">
                {isSearching ? <Spinner /> : "Search"}
              </button>
            </form>
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto min-h-0 pt-4 custom-scrollbar">
          {results.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-gray-500 pb-12 gap-3">
              {isSearching ? <Spinner /> : (
                <>
                  <div className="w-12 h-12 rounded-full border border-white/5 flex items-center justify-center text-xl">♪</div>
                  <p className="text-sm">Search to find new tracks to mix</p>
                </>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 pb-8">
              {results.map((r) => {
                const trackId = toTrackId(r.title) || r.video_id;
                return (
                  <ResultCard
                    key={r.video_id}
                    result={r}
                    importState={importStates[trackId]}
                    inLibrary={libraryIds.has(trackId)}
                    onImport={handleImport}
                    onPlay={setPlayingVideo}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
