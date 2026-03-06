# BeatBot — Backend ↔ Frontend Communication

## Overview

The Python backend is a **FastAPI server** (`src/api/`), deployed on **Cloud Run**.
It owns all ML inference, queue state, cue point data, track metadata, and the
**Firestore feature store** (raw extracted features per track).

It exposes:

- **REST endpoints** for one-shot request/response operations (library, predict cues, edit cues, manage queue)
- **One WebSocket channel** (`/ws/session`) for all real-time push events (playback progress, state changes, warnings)

Audio is read entirely from the **user's local file system** via the browser's
File System Access API — audio never leaves the machine and the server does
**not** stream audio.

---

## How Features and Predictions Flow

```
USER MACHINE
  beatbot extract "/Music"
      │  librosa extraction (~15–30 s/track)
      │  pickle.dumps(Track)  (~150–300 KB)
      ▼
Cloud Run  POST /predict/{track_id}  (Content-Type: application/octet-stream)
      │  deserialise Track
      │  store pkl → Firestore  users/{uid}/features/{track_id}
      │  run LightGBM model  (fresh, every call)
      ▼
PredictResponse JSON  (entry_sec, exit_sec, scores, model_version, …)

───────────────────────────────────────────────────────────────────────────────

WEB APP
  POST /predict/{track_id}  (empty body — no pkl)
      │  Cloud Run fetches pkl from Firestore
      │  run LightGBM model  (always the currently deployed version)
      ▼
PredictResponse JSON  — identical shape, always fresh
```

**No prediction cache.** Deploying a new model to Cloud Run instantly improves
cue points for every user, every track, on the next request.

---

## Transport Summary

| Concern                   | Method                                    | Direction                |
| ------------------------- | ----------------------------------------- | ------------------------ |
| Track list + metadata     | `GET /tracks`                             | Client → Server → Client |
| Upload features + predict | `POST /predict/{track_id}` _(with body)_  | CLI → Server → CLI       |
| Predict (web app)         | `POST /predict/{track_id}` _(empty body)_ | Client → Server → Client |
| Check features uploaded   | `GET /features/{track_id}`                | Client → Server → Client |
| Edit a cue point          | `PATCH /cues/{track_id}`                  | Client → Server → Client |
| Queue state               | `GET /queue`                              | Client → Server → Client |
| Add track to queue        | `POST /queue`                             | Client → Server → Client |
| Reorder queue             | `PATCH /queue/reorder`                    | Client → Server → Client |
| Remove from queue         | `DELETE /queue/{position}`                | Client → Server → Client |
| Trigger early transition  | `POST /transition/early`                  | Client → Server          |
| Playback progress ticks   | WebSocket push                            | Server → Client          |
| State change events       | WebSocket push                            | Server → Client          |
| Model warn / errors       | WebSocket push                            | Server → Client          |
| Audio bytes               | **File System Access API** (local)        | Browser ↔ Local disk     |

---

## 1. Audio Playback

Audio is served entirely from the **user's local file system**, never from the server.

The frontend uses `showDirectoryPicker()` to obtain a directory handle, stored in IndexedDB. When a track needs to play:

1. The handle is resolved to a `File` object via the File System Access API.
2. The `File` is decoded via `audioCtx.decodeAudioData()`.
3. Two `AudioBufferSourceNode` instances (Deck A, Deck B) alternate, routed through individual `GainNode`s:

```
AudioContext
  ├── SourceNode (Deck A) ──→ GainNode A ──→ destination
  └── SourceNode (Deck B) ──→ GainNode B ──→ destination
```

Deck B is preloaded in the background while Deck A plays so **no I/O latency at transition time**.

### Crossfade execution

At `exit_sec` (from `/predict`), the frontend schedules:

```js
gainA.gain.linearRampToValueAtTime(0.0, audioCtx.currentTime + FADE_SECS);
gainB.gain.linearRampToValueAtTime(1.0, audioCtx.currentTime + FADE_SECS);
```

Runs entirely in the browser. The backend is not involved.

---

## 2. REST Endpoints

### `GET /tracks`

Returns the library of processed tracks (server in-memory registry, populated from local `.pkl` files at startup).

**Response**

```json
[
  {
    "track_id": "Bicep - Glue",
    "duration": 285.4,
    "tempo": 128.0,
    "key": "Am",
    "num_bars": 72,
    "has_cue_labels": true
  }
]
```

---

### `POST /predict/{track_id}`

Runs the LightGBM cue ranker and returns per-bar score arrays plus the chosen entry/exit timestamps. **Never reads from or writes to a prediction cache.**

**With body (CLI upload):**

- Body: raw `pickle.dumps(Track)` bytes, `Content-Type: application/octet-stream`
- Stores pkl bytes in `users/{uid}/features/{track_id}` in Firestore
- Runs current model → returns result

**Empty body (web app):**

- Fetches stored pkl from `users/{uid}/features/{track_id}` in Firestore
- Runs current model → returns result
- Returns `404` if no features have been uploaded yet (user hasn't run `beatbot extract`)

**Optional query param:** `?weights={"energy":1.5}` — reserved for future per-request model tuning, not yet applied.

**Response**

```json
{
  "track_id": "Bicep - Glue",
  "num_bars": 72,
  "bar_times": [0.1, 3.79, 7.48, "..."],
  "score_in": [0.12, 0.45, 0.38, "..."],
  "score_out": [0.05, 0.22, 0.61, "..."],
  "entry_sec": 34.2,
  "exit_sec": 228.7,
  "method": "model",
  "model_version": "run_20260218_231046"
}
```

`model_version` reflects the run directory of the model baked into the current Cloud Run image. Bumps automatically when the image is rebuilt with a new model.

---

### `GET /features/{track_id}`

Lightweight status check — does not run model inference.

**Response**

```json
{ "track_id": "Bicep - Glue", "uploaded": true }
```

Used by `beatbot status` to show which tracks have been uploaded without triggering a full prediction.

---

### `PATCH /cues/{track_id}`

User edits a cue marker on the chart. Snaps to nearest bar, persists to `.pkl`, broadcasts to all WS clients.

**Request body**

```json
{
  "cue_type": "entry",
  "timestamp_sec": 41.0,
  "source": "user_drag"
}
```

**Response**

```json
{
  "track_id": "Bicep - Glue",
  "cue_type": "entry",
  "accepted_sec": 41.0,
  "bar_index": 11
}
```

---

### `GET /queue`

Returns current playback queue state.

**Response**

```json
{
  "current_index": 0,
  "tracks": [
    {
      "position": 0,
      "track_id": "Bicep - Glue",
      "entry_sec": 34.2,
      "exit_sec": 228.7
    },
    {
      "position": 1,
      "track_id": "ARTBAT - Horizon",
      "entry_sec": 47.1,
      "exit_sec": 310.5
    }
  ]
}
```

---

### `POST /queue`

Add tracks to the end of the queue. Server runs `/predict` for each and attaches cue data. Triggers `queue.updated` WS push.

**Request body**

```json
{ "track_ids": ["ARTBAT - Horizon", "Bicep - Apricots"] }
```

---

### `PATCH /queue/reorder`

```json
{ "from_position": 3, "to_position": 1 }
```

Triggers `queue.updated` WS push.

---

### `DELETE /queue/{position}`

Remove a track at `position`. Triggers `queue.updated` WS push.

---

### `POST /transition/early`

User clicks "Mix Now". Server advances `current_index`, responds with next track's cue data, and pushes `playback.track_changed` over WS.

**Request body**

```json
{ "fade_secs": 7.0 }
```

**Response**

```json
{
  "next_track_id": "ARTBAT - Horizon",
  "entry_sec": 47.1,
  "exit_sec": 310.5,
  "fade_secs": 7.0
}
```

---

## 3. WebSocket — `/ws/session`

A single persistent connection opened when the React app mounts. All real-time server → client pushes flow through it.

### `playback.tick`

Emitted every **500 ms** while playing.

```json
{
  "type": "playback.tick",
  "track_id": "Bicep - Glue",
  "elapsed_sec": 87.5,
  "duration_sec": 285.4,
  "progress": 0.307,
  "next_transition_in_sec": 141.2
}
```

### `playback.track_changed`

```json
{
  "type": "playback.track_changed",
  "prev_track_id": "Bicep - Glue",
  "curr_track_id": "ARTBAT - Horizon",
  "curr_entry_sec": 47.1,
  "curr_exit_sec": 310.5,
  "queue_position": 1
}
```

### `queue.updated`

```json
{
  "type": "queue.updated",
  "tracks": ["..."]
}
```

### `cues.accepted`

```json
{
  "type": "cues.accepted",
  "track_id": "Bicep - Glue",
  "cue_type": "entry",
  "accepted_sec": 41.0,
  "bar_index": 11
}
```

### `model.warning`

Emitted when heuristic fallback was used instead of the model.

```json
{
  "type": "model.warning",
  "track_id": "Bicep - Glue",
  "message": "Model cues degenerate. Heuristic used.",
  "entry_sec": 34.2,
  "exit_sec": 228.7
}
```

### `error`

```json
{
  "type": "error",
  "code": "audio_not_found",
  "message": "No audio file for 'Bicep - Glue'.",
  "recoverable": false
}
```

---

## 4. Cue Point Edit Flow (end-to-end)

```
User drags entry marker on chart
          │
          ▼
React: PATCH /cues/Bicep - Glue
       { cue_type: "entry", timestamp_sec: 41.0, source: "user_drag" }
          │
          ▼
FastAPI: snap 41.0s → bar 11
         persist to .pkl
         return { accepted_sec: 41.0, bar_index: 11 }
          │
          ├──→ REST response to requester
          └──→ WS push "cues.accepted" to all clients
          │
          ▼
React: re-render chart marker at bar 11
       update local entry_sec used for crossfade scheduling
```

---

## 5. Early Transition Flow (end-to-end)

```
User clicks "Mix Now"
          │
          ▼
React: POST /transition/early { fade_secs: 7.0 }
          │
          ▼
FastAPI: advance current_index
         return next track cue data
          │
          ├──→ REST response: { next_track_id, entry_sec, exit_sec, fade_secs }
          └──→ WS push "playback.track_changed"
          │
          ▼
React: immediately schedule Web Audio API crossfade
       gainA.gain.linearRampToValueAtTime(0, now + 7)
       gainB.gain.linearRampToValueAtTime(1, now + 7)
       (Deck B already decoded from local file system)
```

---

## 6. Session Startup Sequence

```
1. React mounts
      → GET /tracks                            (populate library panel)
      → GET /queue                             (restore queue from server)
      → WS connect /ws/session

2. User picks music folder
      → showDirectoryPicker() stored in IndexedDB
      → library list built from directory entries instantly

3. User opens a track that has features
      → POST /predict/{track_id}  (empty body)
      → Cloud Run: Firestore features → current model → PredictResponse
      → chart rendered, entry/exit cues set

4. User opens a track with no uploaded features
      → POST /predict/{track_id} → 404
      → UI shows "Run `beatbot extract` to get cue points"

5. User builds queue → POST /queue
      → server predicts each track, attaches cue data
      → WS "queue.updated" fires

6. User hits Play
      → Deck A: File resolved from local dir handle → decodeAudioData()
      → Deck B: preloaded in background
      → audioCtx.resume()
      → WS "playback.tick" starts arriving

7. At (exit_sec − fade_secs), frontend schedules crossfade ramps
8. At exit_sec, Deck A gain = 0 / Deck B gain = 1
9. Server emits "playback.track_changed"
10. Frontend loads next file into background Deck A (ping-pong)
```

---

## 7. State Ownership Summary

| State                      | Owner                                 | Sync mechanism                          |
| -------------------------- | ------------------------------------- | --------------------------------------- |
| Track library              | Server (`.pkl` files / Firestore)     | `GET /tracks` on load                   |
| Extracted features (pkl)   | Firestore `users/{uid}/features/{id}` | Written by `beatbot extract` CLI        |
| Cue point positions        | Server (persisted to `.pkl`)          | `PATCH /cues` + WS push                 |
| Queue order                | Server (in-memory)                    | REST CRUD + WS `queue.updated`          |
| Current track / position   | **Both**                              | WS `playback.tick` keeps client in sync |
| Audio buffer (decoded PCM) | Client only                           | File System Access API (local disk)     |
| Crossfade timing           | Client only                           | Scheduled via Web Audio API             |
| ML scores / chart data     | Derived on demand (no cache)          | `POST /predict` response (always fresh) |
| Model version in use       | Server (`app_state.model_version`)    | Returned in every `PredictResponse`     |

---

## Transport Summary

| Concern                  | Method                     | Direction                |
| ------------------------ | -------------------------- | ------------------------ |
| Track list + metadata    | `GET /tracks`              | Client → Server → Client |
| Cue predictions          | `POST /predict/{track_id}` | Client → Server → Client |
| Edit a cue point         | `PATCH /cues/{track_id}`   | Client → Server → Client |
| Queue state              | `GET /queue`               | Client → Server → Client |
| Add track to queue       | `POST /queue`              | Client → Server → Client |
| Reorder queue            | `PATCH /queue/reorder`     | Client → Server → Client |
| Remove from queue        | `DELETE /queue/{position}` | Client → Server → Client |
| Trigger early transition | `POST /transition/early`   | Client → Server          |
| Playback progress ticks  | WebSocket push             | Server → Client          |
| State change events      | WebSocket push             | Server → Client          |
| Model warn / errors      | WebSocket push             | Server → Client          |
| Audio bytes              | HTTP Range streaming       | Client → Server → Client |

---

## 1. Audio Streaming

### Endpoint

```
GET /audio/{track_id}
```

Returns the raw MP3 file using `fastapi.responses.FileResponse`. FastAPI handles
HTTP `Range` headers automatically, enabling the browser to seek within the file
without downloading it fully.

```python
@app.get("/audio/{track_id}")
def stream_audio(track_id: str):
    path = resolve_audio_path(track_id)   # stem → absolute path lookup
    return FileResponse(path, media_type="audio/mpeg")
```

### Client-side playback

The frontend creates two `AudioBufferSourceNode` instances (Deck A, Deck B) via the
Web Audio API and routes them through individual `GainNode`s into a shared
`AudioContext.destination`.

```
AudioContext
  ├── SourceNode (Deck A) ──→ GainNode A ──→ destination
  └── SourceNode (Deck B) ──→ GainNode B ──→ destination
```

Decks alternate: when A is playing, B is preloaded in the background using a
`fetch()` request to `/audio/{next_track_id}` and decoded with
`audioCtx.decodeAudioData()`. No server round trip is needed at transition time.

### Crossfade execution

At `exit_sec` (received from `/predict`), the frontend schedules:

```js
gainA.gain.linearRampToValueAtTime(0.0, audioCtx.currentTime + FADE_SECS);
gainB.gain.linearRampToValueAtTime(1.0, audioCtx.currentTime + FADE_SECS);
```

This runs entirely in the browser with sample-accurate timing. The backend is not
involved in the audio fade itself.

---

## 2. REST Endpoints

### `GET /tracks`

Returns the full library of processed tracks.

**Response**

```json
[
  {
    "track_id": "Bicep - Glue",
    "duration": 285.4,
    "tempo": 128.0,
    "key": "Am",
    "num_bars": 72,
    "has_cue_labels": true
  },
  ...
]
```

---

### `POST /predict/{track_id}`

Runs `BeatBotModel.predict_cue_points()` (or heuristic fallback) and returns the
full per-bar score arrays plus the chosen entry/exit timestamps.

**Response**

```json
{
  "track_id": "Bicep - Glue",
  "num_bars": 72,
  "bar_times": [0.10, 3.79, 7.48, ...],
  "score_in":  [0.12, 0.45, 0.38, ...],
  "score_out": [0.05, 0.22, 0.61, ...],
  "entry_sec": 34.2,
  "exit_sec":  228.7,
  "method": "model"          // "model" | "heuristic"
}
```

`bar_times` is the raw `track.bars` array (seconds). `score_in` / `score_out` are
the normalised model scores indexed by bar. The frontend uses these arrays to render
the cue score chart.

---

### `PATCH /cues/{track_id}`

User drags a cue marker on the chart or types a new timestamp. Saves the override to
the processed `.pkl` file on disk so it persists across sessions.

**Request body**

```json
{
  "cue_type": "entry", // "entry" | "exit"
  "timestamp_sec": 41.0, // new position in seconds
  "source": "user_drag" // "user_drag" | "user_input"
}
```

**Response**

```json
{
  "track_id": "Bicep - Glue",
  "cue_type": "entry",
  "accepted_sec": 41.0, // snapped to nearest bar boundary
  "bar_index": 11
}
```

The backend snaps the requested timestamp to the nearest bar in `track.bars` and
persists it in the `.pkl` file. The `accepted_sec` may differ slightly from
`timestamp_sec` due to snapping.

---

### `GET /queue`

Returns current playback queue state.

**Response**

```json
{
  "current_index": 0,
  "tracks": [
    {
      "position": 0,
      "track_id": "Bicep - Glue",
      "entry_sec": 34.2,
      "exit_sec": 228.7
    },
    {
      "position": 1,
      "track_id": "ARTBAT - Horizon",
      "entry_sec": 47.1,
      "exit_sec": 310.5
    },
    {
      "position": 2,
      "track_id": "Monolink - Father Ocean",
      "entry_sec": 55.0,
      "exit_sec": 295.2
    }
  ]
}
```

---

### `POST /queue`

Add one or more tracks to the end of the queue. The backend immediately runs
`/predict` for each added track and attaches cue data to the queue entry.

**Request body**

```json
{
  "track_ids": ["ARTBAT - Horizon", "Bicep - Apricots"]
}
```

**Response** — updated full queue (same format as `GET /queue`).

After a successful `POST /queue`, the server also pushes a `queue_updated` event
over the WebSocket so other connected clients (e.g., a second browser tab) stay in sync.

---

### `PATCH /queue/reorder`

User drags a track to a new position in the queue UI.

**Request body**

```json
{
  "from_position": 3,
  "to_position": 1
}
```

**Response** — updated full queue.

Triggers a `queue_updated` WebSocket push.

---

### `DELETE /queue/{position}`

Remove a track at `position` from the queue.

**Response** — updated full queue.

Triggers a `queue_updated` WebSocket push.

---

### `POST /transition/early`

User clicks "Skip / Mix Now" before `exit_sec` is naturally reached. The backend
updates its internal state (advances `current_index`) and responds with the next
track's cue data so the frontend can start the crossfade immediately.

**Request body**

```json
{
  "fade_secs": 7.0 // optional override; defaults to server config
}
```

**Response**

```json
{
  "next_track_id": "ARTBAT - Horizon",
  "entry_sec": 47.1,
  "exit_sec": 310.5,
  "fade_secs": 7.0
}
```

The frontend starts the `GainNode` ramps immediately on receiving this response —
no waiting for the scheduled `exit_sec`.

---

## 3. WebSocket — `/ws/session`

A single persistent WebSocket connection is opened when the React app loads. All
real-time server → client pushes flow through it. Every message is a JSON object with
a `type` discriminator field.

### Playback tick — `playback.tick`

Emitted by the server every **500 ms** while a track is playing.

```json
{
  "type": "playback.tick",
  "track_id": "Bicep - Glue",
  "elapsed_sec": 87.5,
  "duration_sec": 285.4,
  "progress": 0.307,
  "next_transition_in_sec": 141.2
}
```

`next_transition_in_sec` is `exit_sec - elapsed_sec`. The frontend uses this to
show a countdown and to schedule the Web Audio API crossfade ramps in advance.

---

### Track changed — `playback.track_changed`

Emitted when the active track advances (either naturally or via early transition).

```json
{
  "type": "playback.track_changed",
  "prev_track_id": "Bicep - Glue",
  "curr_track_id": "ARTBAT - Horizon",
  "curr_entry_sec": 47.1,
  "curr_exit_sec": 310.5,
  "queue_position": 1
}
```

---

### Queue updated — `queue.updated`

Emitted whenever the server-side queue changes (add, remove, reorder, track_changed).

```json
{
  "type": "queue.updated",
  "tracks": [ ... ]     // same format as GET /queue
}
```

---

### Cue accepted — `cues.accepted`

Emitted after a `PATCH /cues` completes successfully (confirms the snap result to
all clients).

```json
{
  "type": "cues.accepted",
  "track_id": "Bicep - Glue",
  "cue_type": "entry",
  "accepted_sec": 41.0,
  "bar_index": 11
}
```

---

### Model warning — `model.warning`

Emitted when `predict_cue_points` produces degenerate output and the heuristic
fallback was used.

```json
{
  "type": "model.warning",
  "track_id": "Bicep - Glue",
  "message": "Model cues degenerate (entry=05:40 exit=05:40). Heuristic used.",
  "entry_sec": 34.2,
  "exit_sec": 228.7
}
```

The frontend can surface this as a subtle badge on the track card so the user knows
the cue positions may be suboptimal.

---

### Error — `error`

General server-side errors (audio file missing, feature extraction failure, etc.).

```json
{
  "type": "error",
  "code": "audio_not_found",
  "message": "No audio file for track_id 'Bicep - Glue'.",
  "recoverable": false
}
```

---

## 4. Cue Point Edit Flow (end-to-end)

```
User drags entry marker on chart
          │
          ▼
React: PATCH /cues/Bicep - Glue
       { cue_type: "entry", timestamp_sec: 41.0, source: "user_drag" }
          │
          ▼
FastAPI: snap 41.0s → bar 11 (41.0s)
         persist to .pkl
         return { accepted_sec: 41.0, bar_index: 11 }
          │
          ├──→ REST response to requester
          └──→ WS push "cues.accepted" to all clients
          │
          ▼
React: re-render chart marker at bar 11
       update local exit/entry_sec used for crossfade scheduling
```

---

## 5. Early Transition Flow (end-to-end)

```
User clicks "Mix Now" button
          │
          ▼
React: POST /transition/early { fade_secs: 7.0 }
          │
          ▼
FastAPI: advance queue current_index
         return next track cue data
          │
          ├──→ REST response: { next_track_id, entry_sec, exit_sec, fade_secs }
          └──→ WS push "playback.track_changed"
          │
          ▼
React: immediately schedule Web Audio API crossfade
       gainA.gain.linearRampToValueAtTime(0, now + 7)
       gainB.gain.linearRampToValueAtTime(1, now + 7)
       (Deck B was already preloaded)
```

---

## 6. Session Startup Sequence

```
1. React mounts
      → GET /tracks               (populate library panel)
      → GET /queue                (restore queue if server keeps state)
      → WS connect /ws/session

2. User builds queue
      → POST /queue { track_ids: [...] }
      → for each queued track, server runs predict; WS "queue.updated" fires

3. User hits Play
      → browser fetches /audio/track_0  (Deck A)
      → browser fetches /audio/track_1  (Deck B, background preload)
      → audioCtx.resume() (required after user gesture)
      → WS "playback.tick" starts arriving

4. At (exit_sec - fade_secs), frontend schedules crossfade ramps
5. At exit_sec, Deck A gain = 0, Deck B gain = 1
6. Server emits "playback.track_changed"
7. Frontend fetches /audio/track_2 into background Deck A (ping-pong)
```

---

## 7. State Ownership Summary

| State                      | Owner                                    | Sync mechanism                          |
| -------------------------- | ---------------------------------------- | --------------------------------------- |
| Track library              | Server (`.pkl` files)                    | `GET /tracks` on load                   |
| Cue point positions        | Server (persisted to `.pkl`)             | `PATCH /cues` + WS push                 |
| Queue order                | Server (in-memory, optionally persisted) | REST CRUD + WS `queue.updated`          |
| Current track / position   | **Both**                                 | WS `playback.tick` keeps client in sync |
| Audio buffer (decoded PCM) | Client only                              | HTTP Range stream                       |
| Crossfade timing           | Client only                              | Scheduled via Web Audio API             |
| ML scores / chart data     | Server (computed on demand)              | `POST /predict` response                |
