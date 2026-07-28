import { useState, useEffect, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { SongRequest, WsEvent } from '../types'
import {
  createSession,
  endSession,
  getActiveSession,
  getSessionRequests,
  resolveRequest,
  uploadYoutube,
} from '../api/client'
import { useFolders } from '../contexts/FolderContext'

interface Props {
  /** Last WS event from the DJ's main WebSocket */
  lastWsEvent: WsEvent | null
  sendWsMessage: (msg: object) => void
}

function toTrackId(title: string): string {
  // eslint-disable-next-line no-control-regex
  return title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .trim()
    .slice(0, 100)
}

function videoIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return u.searchParams.get('v')
  } catch {
    return null
  }
}

type ProcessingState = 'processing' | 'error'

export default function SessionPanel({ lastWsEvent, sendWsMessage }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [showQR, setShowQR] = useState(false)
  const [requests, setRequests] = useState<SongRequest[]>([])
  const [loading, setLoading] = useState(false)
  const [processingRequests, setProcessingRequests] = useState<Record<string, ProcessingState>>({})
  const { saveDownloadedTrack, folders } = useFolders()
  const queryClient = useQueryClient()

  // Check for existing active session on mount
  useEffect(() => {
    getActiveSession()
      .then((s) => setSessionId(s.session_id))
      .catch(() => {}) // No active session
  }, [])

  // Send heartbeats every 30s when session is active
  useEffect(() => {
    if (!sessionId) return
    const interval = setInterval(() => {
      sendWsMessage({ type: 'session.heartbeat' })
    }, 30_000)
    // Send first heartbeat immediately
    sendWsMessage({ type: 'session.heartbeat' })
    return () => clearInterval(interval)
  }, [sessionId, sendWsMessage])

  // Fetch pending requests when session becomes active
  useEffect(() => {
    if (!sessionId) return
    getSessionRequests(sessionId)
      .then(setRequests)
      .catch(() => {})
  }, [sessionId])

  // Listen for new request events from WS
  useEffect(() => {
    if (!lastWsEvent) return
    const ev = lastWsEvent as any
    if (ev.type === 'request.new') {
      setRequests((prev) => [
        ...prev,
        {
          request_id: ev.request_id,
          session_id: sessionId ?? '',
          display_name: ev.display_name,
          source: ev.source,
          track_id: ev.track_id ?? null,
          youtube_url: ev.youtube_url ?? null,
          query: ev.query,
          status: 'pending',
          created_at: ev.created_at ?? Date.now() / 1000,
        },
      ])
    } else if (ev.type === 'request.resolved') {
      setRequests((prev) => prev.filter((r) => r.request_id !== ev.request_id))
      setProcessingRequests((prev) => {
        const next = { ...prev }
        delete next[ev.request_id]
        return next
      })
    } else if (ev.type === 'session.start') {
      setSessionId(ev.session_id)
    } else if (ev.type === 'session.end') {
      setSessionId(null)
      setRequests([])
    }
  }, [lastWsEvent, sessionId])

  const handleGoLive = useCallback(async () => {
    setLoading(true)
    try {
      const res = await createSession()
      setSessionId(res.session_id)
      setShowQR(true)
    } catch (err) {
      console.error('Failed to create session:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleEndSession = useCallback(async () => {
    if (!sessionId) return
    try {
      await endSession(sessionId)
      setSessionId(null)
      setRequests([])
    } catch (err) {
      console.error('Failed to end session:', err)
    }
  }, [sessionId])

  const handleResolve = useCallback(
    async (req: SongRequest, status: 'accepted' | 'denied') => {
      if (!sessionId) return

      if (status === 'accepted' && req.source === 'youtube' && req.youtube_url) {
        // YouTube requests need processing before they can be queued
        if (folders.length === 0) {
          alert('Please link a local folder in your Library before accepting YouTube requests.')
          return
        }

        const videoId = videoIdFromUrl(req.youtube_url)
        if (!videoId) {
          console.error('Invalid YouTube URL:', req.youtube_url)
          return
        }

        const title = req.query || videoId
        const trackId = toTrackId(title) || videoId

        setProcessingRequests((prev) => ({ ...prev, [req.request_id]: 'processing' }))

        try {
          const blob = await uploadYoutube(videoId, title)
          await saveDownloadedTrack(trackId, blob)
          // Bust the library cache so DJEnvironment sees the new track in its metadata lookup
          await queryClient.invalidateQueries({ queryKey: ['tracks'] })
          await resolveRequest(sessionId, req.request_id, 'accepted', trackId)
          // WS event will remove the card
        } catch (err) {
          console.error('Failed to process YouTube request:', err)
          setProcessingRequests((prev) => ({ ...prev, [req.request_id]: 'error' }))
        }
        return
      }

      // Library tracks or denials — resolve immediately
      try {
        await resolveRequest(sessionId, req.request_id, status)
        // WS event will remove it from the list
      } catch (err) {
        console.error('Failed to resolve request:', err)
      }
    },
    [sessionId, folders, saveDownloadedTrack],
  )

  const pendingRequests = requests.filter((r) => r.status === 'pending')

  return (
    <>
      <div className="flex flex-col h-full bg-[#0f0f1a] border border-white/5 rounded-xl overflow-hidden">
        {/* Header */}
        <div className="shrink-0 border-b border-white/5 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-widest text-gray-400">
              Session
            </span>
            {sessionId && (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                <span className="text-[10px] text-red-400 font-medium">LIVE</span>
              </span>
            )}
          </div>
          {pendingRequests.length > 0 && (
            <span className="bg-purple-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
              {pendingRequests.length}
            </span>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto min-h-0 p-3">
          {!sessionId ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <p className="text-gray-600 text-xs text-center">
                Start a live session to let your audience request songs
              </p>
              <button
                onClick={handleGoLive}
                disabled={loading}
                className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-50
                  text-white text-xs font-bold uppercase tracking-wider transition-colors"
              >
                {loading ? 'Starting...' : 'Go Live'}
              </button>
            </div>
          ) : (
            <>
              {/* Session controls */}
              <div className="flex items-center gap-2 mb-3">
                <button
                  onClick={() => setShowQR(true)}
                  className="flex-1 px-3 py-1.5 rounded bg-gray-800/60 border border-white/[0.06]
                    text-[11px] font-medium text-gray-300 hover:text-white hover:bg-gray-700/60 transition-colors"
                >
                  Show QR Code
                </button>
                <button
                  onClick={handleEndSession}
                  className="px-3 py-1.5 rounded bg-gray-800/60 border border-red-500/20
                    text-[11px] font-medium text-red-400 hover:text-red-300 hover:bg-red-950/30 transition-colors"
                >
                  End
                </button>
              </div>

              {/* Requests */}
              {pendingRequests.length === 0 ? (
                <div className="text-center py-6 text-gray-700 text-xs">
                  No pending requests
                </div>
              ) : (
                <ul className="space-y-2">
                  {pendingRequests.map((req) => {
                    const procState = processingRequests[req.request_id]
                    const isProcessing = procState === 'processing'
                    const isError = procState === 'error'
                    return (
                      <li
                        key={req.request_id}
                        className="bg-gray-800/40 border border-white/5 rounded-lg p-3"
                      >
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="min-w-0">
                            <p className="text-white text-xs font-medium truncate">
                              {req.query || req.track_id || 'Unknown'}
                            </p>
                            <p className="text-gray-500 text-[10px] mt-0.5">
                              <span className="text-gray-400">{req.display_name}</span>
                              {' · '}
                              <span
                                className={
                                  req.source === 'library'
                                    ? 'text-green-500'
                                    : 'text-red-400'
                                }
                              >
                                {req.source === 'library' ? 'Library' : 'YouTube'}
                              </span>
                            </p>
                          </div>
                        </div>

                        {isProcessing ? (
                          <div className="mt-1">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-[10px] text-yellow-400 animate-pulse">
                                Processing…
                              </span>
                            </div>
                            <div className="w-full h-1 bg-gray-700 rounded-full overflow-hidden">
                              <div className="h-full bg-yellow-500 rounded-full animate-[progress_1.5s_ease-in-out_infinite]" style={{ width: '60%' }} />
                            </div>
                          </div>
                        ) : isError ? (
                          <div className="flex gap-2 mt-1">
                            <span className="flex-1 text-[10px] text-red-400 py-1">
                              Processing failed
                            </span>
                            <button
                              onClick={() => handleResolve(req, 'accepted')}
                              className="px-2 py-1 rounded text-[10px] font-bold uppercase
                                bg-yellow-600/20 text-yellow-400 hover:bg-yellow-600/40 transition-colors"
                            >
                              Retry
                            </button>
                            <button
                              onClick={() => handleResolve(req, 'denied')}
                              className="px-2 py-1 rounded text-[10px] font-bold uppercase
                                bg-red-600/20 text-red-400 hover:bg-red-600/40 transition-colors"
                            >
                              Deny
                            </button>
                          </div>
                        ) : (
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleResolve(req, 'accepted')}
                              className="flex-1 py-1 rounded text-[10px] font-bold uppercase
                                bg-green-600/20 text-green-400 hover:bg-green-600/40 transition-colors"
                            >
                              Accept
                            </button>
                            <button
                              onClick={() => handleResolve(req, 'denied')}
                              className="flex-1 py-1 rounded text-[10px] font-bold uppercase
                                bg-red-600/20 text-red-400 hover:bg-red-600/40 transition-colors"
                            >
                              Deny
                            </button>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      </div>

      {/* QR Modal */}
      {showQR && sessionId && (
        <QRModal sessionId={sessionId} onClose={() => setShowQR(false)} />
      )}
    </>
  )
}

// Inline QR modal to avoid circular imports
function QRModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  // Lazy import to keep bundle split clean
  const [QRComponent, setQRComponent] = useState<React.ComponentType<any> | null>(null)

  useEffect(() => {
    import('./QRCodeModal').then((mod) => setQRComponent(() => mod.default))
  }, [])

  if (!QRComponent) return null
  return <QRComponent sessionId={sessionId} onClose={onClose} />
}
