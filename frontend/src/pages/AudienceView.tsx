/**
 * AudienceView — mobile-first page for audience members to see
 * the current track, queue, and submit song requests.
 *
 * Route: /live/:sessionId
 * No authentication required.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import type { QueueItem } from "../types";
import { useAudienceWebSocket } from "../hooks/useAudienceWebSocket";
import {
  getSessionState,
  searchSessionLibrary,
  searchYoutube,
  submitSongRequest,
} from "../api/client";

type Tab = "now" | "discovery" | "share";

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function AudienceView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [tab, setTab] = useState<Tab>("now");
  const [ended, setEnded] = useState(false);
  const [djConnected, setDjConnected] = useState(true);
  const [listenerCount, setListenerCount] = useState(0);

  // ── SINGLE SOURCE OF TRUTH ──
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);

  // ── MATHEMATICALLY DERIVED NOW PLAYING ──
  const activeTrackId = queue[currentIndex]?.track_id || null;

  // Request state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [displayName, setDisplayName] = useState(
    () => localStorage.getItem("beatbot_display_name") ?? "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<Set<string>>(new Set());

  // WebSocket
  const { isConnected, lastEvent } = useAudienceWebSocket(sessionId ?? null);

  // Load initial state
  useEffect(() => {
    if (!sessionId) return;
    getSessionState(sessionId)
      .then((s) => {
        setQueue(s.queue || []);
        setCurrentIndex(s.current_index || 0);
        setDjConnected(s.dj_connected);
        if (!s.active) setEnded(true);
      })
      .catch(() => setEnded(true));
  }, [sessionId]);

  // Track state in a ref to avoid dependency loops during WebSocket parsing
  const stateRef = useRef({ queue, currentIndex });
  useEffect(() => {
    stateRef.current = { queue, currentIndex };
  }, [queue, currentIndex]);

  // Handle WS events
  useEffect(() => {
    if (!lastEvent) return;
    const ev = lastEvent;
    const state = stateRef.current;

    switch (ev.type) {
      case "session.state":
        if (ev.queue) setQueue(ev.queue);
        if (ev.current_index !== undefined) setCurrentIndex(ev.current_index);
        setDjConnected(ev.dj_connected);
        setListenerCount(ev.listener_count);
        break;
      case "session.end":
        setEnded(true);
        break;
      case "session.dj_status":
        setDjConnected(ev.connected);
        setListenerCount(ev.listener_count);
        break;
      case "playback.tick":
        if (ev.current_index !== undefined) {
          setCurrentIndex(ev.current_index);
        } else if (ev.track_id) {
          const newIdx = state.queue.findIndex(
            (q) => q.track_id === ev.track_id,
          );
          if (newIdx !== -1) setCurrentIndex(newIdx);
        }
        break;
      case "queue.update":
        if (ev.queue) setQueue(ev.queue);
        if (ev.current_index !== undefined) setCurrentIndex(ev.current_index);
        break;
      case "request.resolved":
        break;
    }
  }, [lastEvent]);

  // Concurrent Search handler
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => {
    if (!searchQuery.trim() || !sessionId) {
      setSearchResults([]);
      return;
    }
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(async () => {
      setSearching(true);
      try {
        const [libRes, ytRes] = await Promise.allSettled([
          searchSessionLibrary(sessionId, searchQuery),
          searchYoutube(searchQuery),
        ]);

        const combinedResults: any[] = [];

        if (libRes.status === "fulfilled" && libRes.value) {
          combinedResults.push(
            ...libRes.value.map((t: any) => ({
              id: t.track_id,
              title: t.track_id,
              source: "library" as const,
              tempo: t.tempo,
              camelot: t.camelot,
              duration: t.duration,
            })),
          );
        }

        if (ytRes.status === "fulfilled" && ytRes.value) {
          combinedResults.push(
            ...ytRes.value.map((r: any) => {
              const videoId = r.video_id ?? r.videoId ?? r.id;
              return {
                id: videoId,
                title: r.title ?? r.snippet?.title,
                source: "youtube" as const,
                youtube_url: `https://www.youtube.com/watch?v=${videoId}`,
              };
            }),
          );
        }

        setSearchResults(combinedResults);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => clearTimeout(searchTimeout.current);
  }, [searchQuery, sessionId]);

  const handleSubmitRequest = useCallback(
    async (result: any) => {
      if (!sessionId || !displayName.trim()) return;
      localStorage.setItem("beatbot_display_name", displayName);
      setSubmitting(true);
      try {
        await submitSongRequest(sessionId, {
          display_name: displayName,
          source: result.source,
          track_id: result.source === "library" ? result.id : undefined,
          youtube_url: result.youtube_url,
          query: result.title || result.id,
        });
        setSubmitted((prev) => new Set(prev).add(result.id));
      } catch (err) {
        console.error("Failed to submit request:", err);
      } finally {
        setSubmitting(false);
      }
    },
    [sessionId, displayName],
  );

  if (ended) {
    return (
      <div className="h-[100dvh] bg-[#07070f] flex items-center justify-center p-6">
        <div className="text-center">
          <p className="text-gray-400 text-lg mb-2">Session Ended</p>
          <p className="text-gray-600 text-sm">
            The DJ has ended this session.
          </p>
        </div>
      </div>
    );
  }

  const visibleQueue = queue.slice(Math.max(currentIndex, 0));

  return (
    <div className="h-[100dvh] bg-[#07070f] text-white flex flex-col max-w-[480px] mx-auto overflow-hidden">
      <header className="shrink-0 px-4 py-3 bg-[#07070f] border-b border-white/5 flex items-center justify-between">
        <span className="text-purple-400 text-base font-bold tracking-tight">
          Beat<span className="text-white">Bot</span>
          <span className="text-[10px] text-red-400 font-medium ml-2 align-middle">
            LIVE
          </span>
        </span>
        <div className="flex items-center gap-2 text-[10px] text-gray-500">
          {!djConnected && <span className="text-yellow-500">DJ offline</span>}
          <span>{listenerCount} listening</span>
          <span
            className={`w-2 h-2 rounded-full ${isConnected ? "bg-green-500" : "bg-gray-600"}`}
          />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto min-h-0">
        {tab === "now" && (
          <div className="p-4 flex flex-col gap-8">
            <div>
              {activeTrackId ? (
                <div className="text-center pt-6">
                  <div className="w-32 h-32 mx-auto mb-6 rounded-2xl bg-purple-600/20 border border-purple-500/30 flex items-center justify-center shadow-[0_0_40px_rgba(168,85,247,0.15)]">
                    <span className="text-5xl">🎵</span>
                  </div>
                  <h2 className="text-white text-lg font-bold mb-1 px-4 truncate">
                    {activeTrackId}
                  </h2>
                  <p className="text-gray-500 text-sm mb-6">Now Playing</p>
                </div>
              ) : (
                <div className="text-center py-16 text-gray-600 text-sm">
                  Waiting for DJ to start playing...
                </div>
              )}
            </div>

            <div>
              <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-3 border-t border-white/10 pt-6">
                Up Next
              </h3>
              {visibleQueue.length === 0 ? (
                <p className="text-gray-600 text-xs text-center py-4">
                  Queue is empty
                </p>
              ) : (
                <ul className="space-y-1 pb-4">
                  {visibleQueue.map((item, i) => (
                    <li
                      key={`${item.track_id}-${item.position}-${i}`}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg ${
                        i === 0
                          ? "bg-green-950/40 border border-green-900/30"
                          : "bg-white/[0.02]"
                      }`}
                    >
                      <span
                        className={`shrink-0 w-6 text-center text-xs font-mono ${i === 0 ? "text-green-400" : "text-gray-600"}`}
                      >
                        {i === 0 ? "▶" : i}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p
                          className={`text-xs truncate ${i === 0 ? "text-white" : "text-gray-400"}`}
                        >
                          {item.track_id}
                        </p>
                        {item.source === "request" && item.requested_by && (
                          <p className="text-[10px] text-purple-400 mt-0.5">
                            Requested by {item.requested_by}
                          </p>
                        )}
                      </div>
                      {item.source === "request" && (
                        <span className="shrink-0 text-[9px] bg-purple-600/30 text-purple-300 px-1.5 py-0.5 rounded-full">
                          REQ
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {tab === "discovery" && (
          <div className="p-4 pb-8">
            <div className="mb-4">
              <label className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold mb-1 block">
                Your Name
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Enter your name"
                className="w-full px-3 py-2 rounded-lg bg-gray-800/60 border border-white/6 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-purple-500/50"
              />
            </div>

            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search DJ Library & YouTube..."
              className="w-full px-3 py-3 rounded-lg bg-gray-800/60 border border-white/6 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-purple-500/50 mb-3 shadow-inner"
            />

            {searching && (
              <p className="text-gray-600 text-xs text-center py-4 animate-pulse">
                Searching everywhere...
              </p>
            )}

            {searchResults.length > 0 && (
              <div className="space-y-3">
                {/* Library results */}
                {searchResults.some((r) => r.source === "library") && (
                  <div>
                    <p className="text-[9px] uppercase tracking-widest text-gray-600 font-semibold mb-1 px-1">
                      DJ Library
                    </p>
                    <ul className="space-y-1">
                      {searchResults
                        .filter((r) => r.source === "library")
                        .map((result) => {
                          const isSubmitted = submitted.has(result.id);
                          return (
                            <li
                              key={`library-${result.id}`}
                              className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.02] hover:bg-white/[0.05] transition-colors"
                            >
                              <div className="flex-1 min-w-0">
                                <p className="text-xs text-gray-300 truncate">{result.title}</p>
                                {result.tempo && (
                                  <p className="text-[10px] text-gray-600 mt-0.5">
                                    {Math.round(result.tempo)} BPM
                                    {result.camelot ? ` · ${result.camelot}` : ""}
                                    {result.duration ? ` · ${fmtTime(result.duration)}` : ""}
                                  </p>
                                )}
                              </div>
                              <button
                                onClick={() => handleSubmitRequest(result)}
                                disabled={submitting || isSubmitted || !displayName.trim()}
                                className={`shrink-0 px-3 py-1.5 rounded text-[10px] font-bold uppercase transition-colors ${
                                  isSubmitted
                                    ? "bg-green-600/20 text-green-400"
                                    : "bg-purple-600/20 text-purple-400 hover:bg-purple-600/40 disabled:opacity-30"
                                }`}
                              >
                                {isSubmitted ? "Sent" : "Request"}
                              </button>
                            </li>
                          );
                        })}
                    </ul>
                  </div>
                )}

                {/* YouTube results */}
                {searchResults.some((r) => r.source === "youtube") && (
                  <div>
                    <p className="text-[9px] uppercase tracking-widest text-gray-600 font-semibold mb-1 px-1">
                      YouTube
                    </p>
                    <ul className="space-y-1">
                      {searchResults
                        .filter((r) => r.source === "youtube")
                        .map((result) => {
                          const isSubmitted = submitted.has(result.id);
                          return (
                            <li
                              key={`youtube-${result.id}`}
                              className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.02] hover:bg-white/[0.05] transition-colors"
                            >
                              <div className="flex-1 min-w-0">
                                <p className="text-xs text-gray-300 truncate">{result.title}</p>
                              </div>
                              <button
                                onClick={() => handleSubmitRequest(result)}
                                disabled={submitting || isSubmitted || !displayName.trim()}
                                className={`shrink-0 px-3 py-1.5 rounded text-[10px] font-bold uppercase transition-colors ${
                                  isSubmitted
                                    ? "bg-green-600/20 text-green-400"
                                    : "bg-red-600/20 text-red-400 hover:bg-red-600/40 disabled:opacity-30"
                                }`}
                              >
                                {isSubmitted ? "Sent" : "Request"}
                              </button>
                            </li>
                          );
                        })}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {!searching && searchQuery && searchResults.length === 0 && (
              <p className="text-gray-600 text-xs text-center py-4">
                No results found
              </p>
            )}
          </div>
        )}

        {tab === "share" && (
          <div className="p-6 flex flex-col items-center gap-6">
            <div>
              <h2 className="text-white text-base font-bold text-center mb-1">
                Invite Friends
              </h2>
              <p className="text-gray-500 text-xs text-center">
                Scan or share the link to join this session
              </p>
            </div>

            <div className="bg-white rounded-2xl p-4 shadow-[0_0_40px_rgba(168,85,247,0.2)]">
              <QRCodeSVG
                value={`${window.location.origin}/live/${sessionId}`}
                size={200}
                level="M"
                bgColor="#ffffff"
                fgColor="#07070f"
              />
            </div>

            <div className="w-full bg-gray-800/60 rounded-xl px-4 py-3 flex items-center gap-3 border border-white/6">
              <span className="flex-1 text-gray-400 text-xs font-mono truncate">
                {window.location.href}
              </span>
              <button
                onClick={() =>
                  navigator.clipboard
                    .writeText(window.location.href)
                    .catch(() => {})
                }
                className="shrink-0 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold transition-colors"
              >
                Copy
              </button>
            </div>

            <p className="text-gray-700 text-[10px] text-center">
              {listenerCount} {listenerCount === 1 ? "person" : "people"} listening now
            </p>
          </div>
        )}
      </div>

      <nav className="shrink-0 bg-[#07070f] border-t border-white/5 flex pb-safe shadow-2xl relative z-10">
        {[
          { key: "now" as Tab, label: "Now Playing", icon: "🎵" },
          { key: "discovery" as Tab, label: "Discover", icon: "🔍" },
          { key: "share" as Tab, label: "Share", icon: "📲" },
        ].map(({ key, label, icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 flex flex-col items-center gap-1 py-3 min-h-[56px] transition-colors ${tab === key ? "text-purple-400" : "text-gray-600"}`}
          >
            <span className="text-lg">{icon}</span>
            <span className="text-[10px] font-medium">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
