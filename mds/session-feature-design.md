# Live Session & Audience Request System

## Overview

DJs can start a **live session** that generates a shareable link + QR code. Audience members open the link on their phones, see the current track and queue in real time, and submit song requests. The DJ sees incoming requests in a session panel and accepts or denies them. Accepted requests enter the queue after existing audience requests but ahead of DJ-queued tracks.

---

## Session Lifecycle

### 1. DJ Starts a Session

- DJ clicks **"Go Live"** in the DJ Environment.
- Backend creates a `Session` document in Firestore:
  ```
  sessions/{session_id}
    dj_uid: string
    created_at: timestamp
    active: bool
    ended_at: timestamp | null
    last_heartbeat_at: timestamp
    dj_connected: bool
    current_track: TrackMeta | null
    current_index: number
    elapsed_sec: number
    queue: QueueEntry[]
    analytics: { peak_listeners, unique_listeners, total_requests, accepted_requests, denied_requests, tracks_played[], duration_sec }
  ```
- `session_id` is a short, URL-friendly nanoid (e.g. `Bx3kQ9`).
- Returns the session URL: `https://beatbot-35280.web.app/live/{session_id}`

### 2. QR Code Generation

- Frontend generates a QR code client-side encoding the session URL using a lightweight library (`qrcode.react`).
- DJ can:
  - Display QR fullscreen (for projecting at a venue).
  - Copy the link to share on socials / group chats.
- No backend involvement for QR generation — it's purely the session URL encoded as QR.

### 3. Session Resilience & Recovery

The session must survive DJ disconnects, browser crashes, and machine reboots.

#### Heartbeat & Inactivity Timeout
- The DJ client sends a `session.heartbeat` WebSocket message every **30 seconds**.
- Backend tracks `last_heartbeat_at` on the session document.
- A server-side scheduled task (Cloud Run cron or Firestore TTL) checks every minute:
  - If `last_heartbeat_at` is older than **5 minutes** and session is still `active` → auto-terminate the session.
- Audience clients see: "DJ appears to be offline. Waiting for reconnect..." for the first 5 minutes, then "Session ended" after timeout.

#### State Persistence for Recovery
- All session state is persisted to Firestore, **not just in-memory**:
  - `current_track`, `queue`, `current_index`, `playback.elapsed_sec` are written on every meaningful change (track advancement, queue mutation, every 10s playback checkpoint).
  - Pending requests already live in Firestore.
- On DJ reconnect (page reload, new tab, machine reboot):
  1. Frontend checks `GET /sessions/active` → returns the DJ's active session if one exists.
  2. If found, DJ Environment restores: queue, current track, pending requests, session ID, QR code.
  3. The audio engine reloads the current track and seeks to the last persisted `elapsed_sec`.
  4. WebSocket reconnects and resumes heartbeats. Audience clients see the DJ come back online.
  5. A **"Resume Session" banner** appears so the DJ confirms they're back (avoids ghost sessions from stale tabs).

#### Edge Cases
| Scenario | Behavior |
|---|---|
| DJ closes tab without clicking "End Session" | Heartbeat stops → 5 min timeout → auto-terminate |
| DJ's machine crashes mid-track | Same as above. On reboot, DJ can recover within the 5 min window |
| DJ opens BeatBot in a new tab while session is active | New tab detects active session via `GET /sessions/active`, offers "Resume Session" |
| DJ has two tabs open, closes one | Heartbeat continues from the remaining tab — no interruption |
| DJ's internet drops temporarily (<5 min) | WebSocket reconnects with exponential backoff (existing logic). Audience sees buffering state. Heartbeat resumes on reconnect |
| DJ's internet drops for >5 min | Session auto-terminates. DJ can start a new session on reconnect (old session becomes a past session with analytics) |
| Backend/Cloud Run restarts | On startup, load active sessions from Firestore into in-memory state. No data loss since Firestore is the source of truth |
| Audience member refreshes during DJ disconnect | `GET /sessions/{id}` returns last known state from Firestore with a `dj_connected: false` flag |

### 4. DJ Ends Session

- DJ clicks **"End Session"** or session auto-terminates after 5 min inactivity.
- Backend marks `active: false`, sets `ended_at: timestamp`.
- Audience clients see a "Session ended" screen.
- Session data is retained in Firestore for analytics (never deleted, just deactivated).

---

## Session History & Analytics

### Profile Section: Past Sessions

Each DJ's profile includes a **"Sessions"** tab showing all past sessions, ordered by most recent.

#### Session Card
- Date & time, duration.
- Peak listeners, total unique listeners.
- Total requests received / accepted / denied.
- Tracks played count.

#### Session Detail View
- Full track list in play order (with timestamps).
- Request log: who requested what, accepted or denied.
- Listener count over time (sparkline chart).
- Top requested artists/tracks.

### Data Model Additions

The `sessions/{session_id}` document gains analytics fields, populated in real-time and finalized on session end:

```
sessions/{session_id}
  ...existing fields...
  ended_at: timestamp | null
  last_heartbeat_at: timestamp
  dj_connected: bool
  analytics:
    peak_listeners: number
    unique_listeners: number        # count of distinct audience WebSocket connections
    total_requests: number
    accepted_requests: number
    denied_requests: number
    tracks_played: string[]         # ordered list of track_ids
    duration_sec: number            # ended_at - created_at
```

Listener tracking: each audience WebSocket connection is counted. A `listener_id` (random nanoid stored in the audience client's localStorage) deduplicates across reconnects.

### API Endpoints for History

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/sessions/history` | DJ | List past sessions with summary analytics |
| `GET` | `/sessions/{session_id}/analytics` | DJ | Full analytics for a specific session |

---

## Audience Experience (Mobile-First)

All audience views are **unauthenticated** — no sign-up required. The session ID in the URL is the only credential.

### `/live/{session_id}` — Audience View

A single-page mobile-optimized view with three sections:

#### Now Playing
- Album art / waveform thumbnail, track title, artist.
- Live progress bar synced via WebSocket.

#### Queue
- Scrollable list of upcoming tracks.
- Each entry shows title, artist, and a badge: **DJ** or **Request** (with requester name).

#### Request a Song (bottom sheet / tab)
- **Search bar** with two source tabs:
  1. **DJ Library** — searches the DJ's uploaded track library (`GET /tracks?q=...`).
  2. **YouTube** — searches YouTube via the existing discover/upload flow.
- Tapping a result opens a confirmation: "Request this song?"
- On confirm → `POST /sessions/{session_id}/requests` with `{ query, source, youtube_url?, track_id? }`.
- Audience member enters a display name (stored in localStorage for repeat use).

### Mobile UX Details
- Bottom navigation: **Now Playing** | **Queue** | **Request**.
- All touch targets ≥ 48px.
- Dark theme matching DJ Environment.
- No horizontal scrolling. Fully responsive, max-width 480px centered.

---

## Request Flow

### Data Model

```
session_requests/{request_id}
  session_id: string
  display_name: string
  source: "library" | "youtube"
  track_id: string | null       # if from DJ library
  youtube_url: string | null     # if from YouTube
  query: string                  # original search text
  status: "pending" | "accepted" | "denied"
  created_at: timestamp
```

### DJ Session Panel

New panel in the DJ Environment sidebar: **"Requests"** (with badge count for pending).

Each request card shows:
- Requester name, source icon (library / YouTube), track title.
- **Accept** / **Deny** buttons.

### Accept Flow

1. DJ taps **Accept**.
2. If source is `library` → track is already processed; skip to step 4.
3. If source is `youtube` → backend triggers the existing upload pipeline:
   - Download audio via `yt-dlp`.
   - Extract features (BPM, key, energy, etc.).
   - Predict cue points via LightGBM model.
4. Track enters the queue at the **next available request slot**:
   - Request tracks always go after the currently playing track and any previously accepted requests.
   - They go **before** DJ-queued tracks that haven't been promoted.
   - This means the queue order is: `[Now Playing] → [Accepted Requests FIFO] → [DJ Queue]`.
5. WebSocket broadcasts queue update to all audience clients.
6. Request status set to `accepted`.

### Deny Flow

1. Status set to `denied`.
2. Audience member sees "Not added" on their request history (no reason given).

---

## Queue Priority Logic

The queue maintains two logical zones after the current track:

```
Position 0: Currently playing
─────────────────────────────
REQUEST ZONE (FIFO):
  - Accepted request 1
  - Accepted request 2
  - ...
DJ ZONE:
  - DJ-queued track A
  - DJ-queued track B
  - ...
```

- New accepted requests append to the end of the **request zone**.
- DJ can still reorder within the DJ zone.
- DJ can drag a request-zone track into the DJ zone (demoting it) or vice versa.
- Each `QueueEntry` gains a new field: `source: "dj" | "request"` and optionally `requested_by: string`.

---

## WebSocket Extensions

Extend the existing `/ws/session` WebSocket with new event types:

| Event | Direction | Payload |
|---|---|---|
| `session.start` | server → all | `{ session_id }` |
| `session.end` | server → all | `{}` |
| `session.heartbeat` | DJ → server | `{}` (sent every 30s) |
| `session.dj_status` | server → audience | `{ connected: bool }` |
| `request.new` | server → DJ | `{ request_id, display_name, query, source }` |
| `request.resolved` | server → audience | `{ request_id, status }` |
| `queue.update` | server → all | `{ queue: QueueEntry[] }` (existing) |
| `playback.tick` | server → all | (existing) |

Audience clients connect to a new endpoint: `GET /ws/live/{session_id}` — read-only, no auth required.

---

## API Endpoints (New)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/sessions` | DJ (Firebase token) | Create a new live session |
| `GET` | `/sessions/active` | DJ | Get DJ's current active session (for recovery) |
| `DELETE` | `/sessions/{session_id}` | DJ | End session |
| `GET` | `/sessions/history` | DJ | List past sessions with summary analytics |
| `GET` | `/sessions/{session_id}/analytics` | DJ | Full analytics for a specific session |
| `GET` | `/sessions/{session_id}` | None | Get session state (current track, queue) |
| `GET` | `/sessions/{session_id}/library` | None | Search DJ's library |
| `POST` | `/sessions/{session_id}/requests` | None | Submit a song request |
| `GET` | `/sessions/{session_id}/requests` | DJ | List pending requests |
| `PATCH` | `/sessions/{session_id}/requests/{id}` | DJ | Accept or deny a request |

---

## Frontend Routes (New)

| Route | Component | Description |
|---|---|---|
| `/live/{session_id}` | `AudienceView` | Mobile audience page |
| `/profile/sessions` | `SessionHistory` | Past sessions list with analytics |
| `/profile/sessions/{id}` | `SessionDetail` | Detailed analytics for one session |
| Existing DJ env | `SessionPanel` | New sidebar panel for DJ |
| Existing DJ env | `QRCodeModal` | Fullscreen QR display |

---

## Tech Choices

| Concern | Choice |
|---|---|
| QR generation | `qrcode.react` (client-side, zero backend cost) |
| Short session IDs | `nanoid` (6-8 chars, URL-safe) |
| Audience auth | None — session ID acts as access token |
| Real-time sync | Existing WebSocket infra + new audience endpoint |
| Request persistence | Firestore `session_requests` collection |
| Session persistence | Firestore `sessions` collection |
| Mobile styling | Existing dark theme + responsive CSS, bottom nav pattern |

---

## Implementation Order

1. **Backend: Session CRUD** — create/end session, Firestore model, nanoid generation.
2. **Backend: Audience WebSocket** — read-only `/ws/live/{session_id}` endpoint.
3. **Frontend: QR code + Go Live button** — session creation, QR modal, link copy.
4. **Frontend: Audience View** — now playing, queue display, mobile layout.
5. **Backend: Request endpoints** — submit, list, accept/deny.
6. **Frontend: Request search UI** — library search + YouTube search tabs.
7. **Frontend: DJ Request Panel** — incoming requests with accept/deny.
8. **Backend: Queue priority logic** — request zone vs DJ zone insertion.
9. **Polish** — animations, error states, session expiry, rate limiting on requests.
