# BeatBot — AI-Powered DJ Mixing Tool

BeatBot is an AI-powered mixing assistant that analyses house music tracks and automatically selects the optimal **entry** and **exit** cue points for seamless DJ transitions. A React frontend gives the user full visibility into the model's predictions and lets them trigger or override crossfades in real time.

---

## Table of Contents

- [Use Case](#use-case)
- [Project Structure](#project-structure)
- [The Model](#the-model)
- [Feature Engineering](#feature-engineering)
- [API](#api)
- [Frontend](#frontend)
- [Running Locally](#running-locally)
- [Data](#data)

---

## Use Case

A user loads a playlist of house music tracks into the queue. BeatBot:

1. Analyses each track with `librosa` and the `FeatureExtractor` pipeline.
2. Scores every bar in the track with the trained **dual LambdaRank** model.
3. Surfaces the best **entry** and **exit** bar for each track in the UI.
4. Automatically crossfades to the next track when the exit cue approaches, or immediately on user request.

The user can inspect the scoring charts, manually drag cue points, skip the upcoming track, reorder the queue, and adjust the crossfade duration — all without touching the model.

---

## Project Structure

```
BeatBot/
├── src/                        # Python back-end
│   ├── api/                    # FastAPI application
│   │   ├── main.py             # App factory, CORS, router registration
│   │   ├── state.py            # Shared runtime state (queue, cue cache, predict_cues)
│   │   ├── schemas.py          # Pydantic request / response models
│   │   ├── ws_manager.py       # WebSocket connection manager
│   │   └── routes/
│   │       ├── audio.py        # GET /audio/{track_id}  — streams MP3
│   │       ├── tracks.py       # GET /tracks            — lists library
│   │       ├── queue.py        # Queue CRUD + reorder
│   │       ├── predict.py      # POST /predict/{track_id}
│   │       ├── cues.py         # PATCH /cues/{track_id}
│   │       ├── session.py      # WebSocket /ws/session
│   │       └── transition.py   # POST /transition/now
│   ├── model/
│   │   └── lightgbm.py         # BeatBotModel — dual LambdaRank wrapper
│   ├── extractor/
│   │   └── extractor.py        # Audio → Track pipeline (librosa)
│   ├── features.py             # FeatureExtractor — 40+ features per bar
│   ├── track.py                # Track dataclass
│   └── annotator.py            # Annotation helper (JAMS format)
│
├── frontend/                   # React + TypeScript UI
│   └── src/
│       ├── App.tsx             # Root: queue state, deck routing, crossfade logic
│       ├── api/client.ts       # Typed fetch helpers for every API route
│       ├── hooks/
│       │   ├── useAudioEngine.ts   # Web Audio API playback engine
│       │   └── useWebSocket.ts     # WS client with exponential-backoff reconnect
│       ├── components/
│       │   ├── Deck.tsx        # NOW PLAYING / UP NEXT panel
│       │   ├── CueChart.tsx    # Recharts score visualisation (entry + exit)
│       │   ├── FeatureCharts.tsx   # Energy, beat strength, vocal confidence
│       │   ├── WaveformView.tsx    # WaveSurfer.js waveform with cue markers
│       │   ├── Queue.tsx       # Drag-and-drop queue list
│       │   ├── Transport.tsx   # Play / Stop / Mix Now controls
│       │   └── ErrorBoundary.tsx
│       └── types/              # Shared TypeScript interfaces
│
├── data/
│   ├── custom/
│   │   ├── house_music_personal.csv    # Personal track library
│   │   └── annotations/                # JAMS annotation files
│   ├── M-DJCUE/                        # Academic dataset (EDM)
│   ├── models/                         # Serialised model runs (.pkl)
│   └── processed/                      # Pre-extracted feature cache
│
├── mds/                        # Design and architecture notes
├── pyproject.toml
└── makefile
```

---

## The Model

BeatBot uses a **Learning-to-Rank (LambdaRank)** approach implemented in LightGBM (`src/model/lightgbm.py`).

### Why Learning-to-Rank?

DJing is inherently a ranking problem, not a classification one. Some bars are *perfect* cue points, others are *acceptable*, and most are irrelevant. LambdaRank directly optimises **NDCG** (Normalized Discounted Cumulative Gain), which rewards pushing the best bars to the top of the ranked list.

### Dual Rankers

Two separate models are trained for the two halves of the mixing decision:

| Model | Goal | Configuration |
|---|---|---|
| **Entry Ranker** | Structural beginnings — intros, breakdowns | High regularisation (`reg_lambda=15`), shallow trees (`max_depth=3`) to learn general structural rules rather than overfitting |
| **Exit Ranker** | Structural endings — outros, post-chorus | Lower regularisation (`reg_lambda=5`), deeper trees (`max_depth=4`) to capture complex energy dynamics |

### Training Labels

Each bar in a training track is given a **graded relevance label**:

- `2` — Perfect cue (exact human annotation)
- `1` — Acceptable (within ±2 bars of annotation)
- `0` — Not a cue point

### Inference

At inference time (`src/api/state.py → predict_cues`):

1. `FeatureExtractor.extract(track)` produces a feature matrix (one row per bar).
2. Both rankers score every bar.
3. A **positional weight** discourages exit cues in the final ~15% of the track (where the model would otherwise exploit the structural similarity of outros).
4. If the selected entry and exit are implausibly close, the exit score is masked within `min_sep_bars` of the entry and the best remaining candidate is chosen.
5. Results are cached per track and returned to the frontend within ~200 ms.

### Model Artefacts

Trained models are saved under `data/models/`. Each run directory contains:
- `beatbot_model.pkl` — serialised `BeatBotModel`
- `evaluation.json` — NDCG scores and feature importances
- `figures/` — training curves and prediction plots

---

## Feature Engineering

`src/features.py` computes **40+ features per bar**, organised into 9 tiers:

| Tier | Features | Purpose |
|---|---|---|
| 1 – Structure | `bar_pos_norm`, `dist_to_section`, `phrase_pos`, `duration` | "Where am I in the song?" |
| 2 – Energy | `energy_prev_8`, `energy_next_8`, `energy_volatility`, `energy_derivative`, `beat_strength` | "How energetic is this section?" |
| 3 – Timbre | `spectral_centroid`, `vocal_conf`, `harmonic_ratio`, `high_band_energy` | "What does it sound like?" |
| 4 – Chroma | `chroma_rel_0/3/7/9/11` | Key-invariant harmonic function (Tonic, Minor-3rd, Dominant…) |
| 5 – Rhythmic Grid | `is_4_bar`, `bar_mod_8/16/32` | Phrasing alignment — mixes should land on the "1" |
| 6 – Flux | `energy_flux`, `spectral_flux` | Instantaneous change (drops, crashes) |
| 7 – Advanced Context | `energy_contrast_future`, `is_likely_breakdown`, `vocal_future_8`, `vocal_past_8` | Look-ahead / look-behind "human" features |
| 8 – Metadata | `is_section_start`, `beat_consistency`, `percussion_intensity`, `spectral_rolloff` | Structural and rhythmic metadata |
| 9 – Composite | `phrase_boundary_strength` | Count of grid alignments (0–5) — strong downbeat signal |

Chroma features are **key-invariant**: the raw 12-bin chroma vector is rotated by the track's detected tonic so the model learns harmonic *function* (Dominant, Subdominant) rather than absolute pitch class.

---

## API

The backend is a **FastAPI** app (`src/api/`) served by uvicorn.

```bash
PYTHONPATH=src .venv/bin/uvicorn api.main:app --reload --app-dir src
# Runs on http://localhost:8000
```

Key endpoints:

| Method | Path | Description |
|---|---|---|
| `GET` | `/tracks` | List all tracks in the library |
| `GET` | `/audio/{track_id}` | Stream the MP3 file |
| `POST` | `/predict/{track_id}` | Run cue prediction; returns scores + selected cues |
| `PATCH` | `/cues/{track_id}` | Override a cue point; validates and broadcasts via WS |
| `GET/POST/DELETE` | `/queue` | Queue management |
| `PATCH` | `/queue/reorder` | Reorder two queue positions |
| `POST` | `/transition/now` | Trigger immediate crossfade |
| `WS` | `/ws/session` | Real-time push events (`queue.updated`, `cues.accepted`) |

---

## Frontend

The UI is a **React 19 + TypeScript** single-page app built with Vite 6.

```bash
cd frontend && pnpm install && pnpm dev
# Runs on http://localhost:5173
```

Key design decisions:

- **Two physical decks (A / B)** alternate roles as NOW PLAYING and UP NEXT. The `activeDeck` ref drives all routing logic so async crossfades never touch the wrong slot.
- **Web Audio engine** (`useAudioEngine`) handles all playback, crossfading, and elapsed-time reporting.
- **WaveSurfer.js** renders the waveform but is staggered 3.5 s after deck load to avoid a simultaneous double PCM-decode that triggers Chrome OOM crashes.
- **WebSocket** (`useWebSocket`) reconnects with exponential backoff (150 ms → 5 s cap) so uvicorn `--reload` restarts are transparent.
- **Recharts** charts (cue scores + feature charts) share a `syncId` for synchronised hover cursors and render a live playhead `ReferenceLine`.

---

## Running Locally

**Prerequisites:** Python ≥ 3.13, Node.js ≥ 20, pnpm.

```bash
# 1. Python environment
python3.13 -m venv .venv
source .venv/bin/activate
pip install -e .

# 2. Backend
PYTHONPATH=src uvicorn api.main:app --reload --app-dir src

# 3. Frontend (separate terminal)
cd frontend
pnpm install
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173).

---

## Data

| Path | Contents |
|---|---|
| `data/custom/annotations/` | JAMS files — manually annotated cue points for ~100 house tracks |
| `data/custom/house_music_personal.csv` | Track metadata (BPM, key, duration, file path) |
| `data/M-DJCUE/` | Academic EDM dataset used for additional training signal |
| `data/models/` | Serialised model runs; the active model path is configured in `src/api/state.py` |
| `data/processed/` | Pre-extracted feature DataFrames cached as Parquet — regenerated by `src/extractor/extractor.py` if missing |