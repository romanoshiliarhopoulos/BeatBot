/**
 * daemonClient — communicates with the local beatbot daemon on 127.0.0.1:7337.
 *
 * The daemon is a FastAPI sidecar started by:
 *   beatbot daemon
 *
 * All functions here time out quickly so the Discover page can detect a
 * missing daemon without hanging.
 */

import { firebaseAuth } from '../lib/firebase'

const DAEMON = "http://127.0.0.1:7337"
const WS_URL = "ws://127.0.0.1:7337/ws"

async function getAuthToken(): Promise<string | undefined> {
  try {
    if (firebaseAuth?.currentUser) {
      return await firebaseAuth.currentUser.getIdToken()
    }
    const session = localStorage.getItem("beatbot_dev_session")
    if (session) {
      const parsed = JSON.parse(session)
      if (parsed && parsed.uid) {
         return "dev-" + parsed.uid
      }
    }
  } catch {
    // ignore
  }
  return undefined
}

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
  skipped?: boolean    // true when file already existed locally
  message?: string     // error detail
  file_path?: string   // set on "done"
}

// ── Health ─────────────────────────────────────────────────────────────────

/** Returns true if the daemon is reachable. Times out after 1.5 s. */
export async function daemonHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${DAEMON}/health`, {
      signal: AbortSignal.timeout(1500),
    })
    return res.ok
  } catch {
    return false
  }
}

// ── Config ─────────────────────────────────────────────────────────────────

export async function daemonGetConfig(): Promise<{ music_dir: string }> {
  const res = await fetch(`${DAEMON}/config`)
  if (!res.ok) throw new Error("Config fetch failed")
  return res.json()
}

export async function daemonSetMusicDir(music_dir: string): Promise<void> {
  const res = await fetch(`${DAEMON}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ music_dir }),
  })
  if (!res.ok) throw new Error("Config update failed")
}

// ── Search ─────────────────────────────────────────────────────────────────

export async function daemonSearch(q: string): Promise<SearchResult[]> {
  const res = await fetch(`${DAEMON}/search?q=${encodeURIComponent(q)}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.detail ?? `Search failed (${res.status})`)
  }
  return res.json()
}

// ── Import ─────────────────────────────────────────────────────────────────

export async function daemonImport(
  video_id: string,
  title: string,
): Promise<{ track_id: string }> {
  const id_token = await getAuthToken()
  const res = await fetch(`${DAEMON}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_id, title, id_token }),
  })
  if (!res.ok) throw new Error(`Import request failed (${res.status})`)
  return res.json()
}

// ── WebSocket ──────────────────────────────────────────────────────────────

/**
 * Opens a persistent WebSocket to the daemon and calls onMessage with each
 * ImportProgress event. Automatically reconnects after disconnects as long as
 * the returned cleanup function hasn't been called.
 *
 * Returns a cleanup function — call it when the component unmounts.
 */
export function connectDaemonWS(
  onMessage: (msg: ImportProgress) => void,
  onStatusChange?: (connected: boolean) => void,
): () => void {
  let ws: WebSocket | null = null
  let active = true
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  function connect() {
    if (!active) return
    ws = new WebSocket(WS_URL)

    ws.onopen = () => {
      onStatusChange?.(true)
    }

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as ImportProgress
        if (msg.type === "import_progress") onMessage(msg)
      } catch {
        // ignore malformed frames
      }
    }

    ws.onclose = () => {
      onStatusChange?.(false)
      if (active) {
        retryTimer = setTimeout(connect, 2000)
      }
    }

    ws.onerror = () => {
      // onclose will fire right after — let it handle the retry
    }
  }

  connect()

  return () => {
    active = false
    if (retryTimer) clearTimeout(retryTimer)
    ws?.close()
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Format seconds → "m:ss" */
export function fmtDuration(secs: number): string {
  if (!secs) return "—"
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${s.toString().padStart(2, "0")}`
}
