# BeatBot — User Flow

## Overview

BeatBot is a two-part system: a **CLI** (`beatbot` pip package) that runs on the user's machine and a **web app** (React/Vite) that runs in the browser. Audio never leaves the user's machine — only extracted features (~150–300 KB pkl blobs) travel to the cloud.

---

## First-Time Setup

### 1. Create an account

Open `beatbot-35280.web.app` → **Sign in** → create a Firebase email/password account.

### 2. Install the CLI

```bash
pipx install beatbot   # or: pip install beatbot
beatbot login          # Firebase credentials → saved to ~/.beatbot/credentials.json
```

### 3. Extract and upload features

```bash
beatbot extract "/path/to/Music"
```

For each `.mp3` the CLI:

- Runs `librosa` feature extraction (~15–30 s / track).
- Pickles the `Track` object (~150–300 KB).
- `POST /predict/{track_id}` → Cloud Run stores the pkl in Firestore and returns fresh cue predictions.
- Already-uploaded tracks are skipped automatically; use `--force` to re-upload.

---

## DJ Session Flow

### 4. Open the web app

- On login the app goes directly to **DJEnvironment** (no onboarding step).
- Track list via `GET /tracks` — only tracks with uploaded features appear in the library.

### 5. Grant audio folder access

- The browser shows a folder picker (`showDirectoryPicker()`) the first time a track is loaded.
- The granted handle is persisted in IndexedDB; no re-picking across page reloads.

### 6. Load a track onto a deck

- Click a track from the library, or let the queue auto-advance.
- `POST /predict/{track_id}` (empty body) → Cloud Run fetches pkl from Firestore → runs the currently deployed LightGBM model → returns `{entry_sec, exit_sec, scores, …}`.
- **No prediction cache** — every load uses the current model.

### 7. Playback

- Two-deck crossfade engine (Deck A ↔ Deck B) via the Web Audio API.
- BeatBot auto-schedules crossfade at `exit_sec` → `entry_sec` of the next track.
- **Early transition**: "→ Mix Now" button → `POST /transition/early`.

### 8. Cue point editing

- Drag cue markers on the cue chart → `PATCH /cues/{track_id}` persists the change.

### 9. Queue management

- Add, reorder, or remove tracks. Queue is server-side (`GET/POST/PATCH/DELETE /queue`).

---

## Library Management (Library tab)

- **View** all uploaded tracks with BPM, duration, CLI badge.
- **Delete** individual tracks (removes from Firestore library + features).
- **Purge orphaned** — removes server entries for tracks no longer in the local folder.
- **Clear all** — hard-wipes library and features for the current user.

---

## Model Updates

Deploy a new model to Cloud Run → every subsequent predict call uses it instantly. No cache to invalidate.

---

## Screen Layout

```
+----------------------------------------------------------+
|  BeatBot     [ DJ | Library ]               [Sign out]  |
+------------------------+--------------------------------+
|  PLAYING (Deck A)      |  UP NEXT (Deck B)             |
|  Waveform              |  Waveform                     |
|  Cue chart             |  Cue chart                    |
|  Feature charts        |  Feature charts               |
|  Transport: play/pause/Mix Now                         |
+----------------------------------------------------------+
|  Queue  (track list, drag to reorder)                  |
+----------------------------------------------------------+
```
