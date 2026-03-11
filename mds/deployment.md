# BeatBot — Deployment

## TL;DR

- **No Cloud Storage** — feature data travels inline as pickle bytes in prediction requests; model artifacts are baked into the Docker image.
- **Local CLI extracts** — users install `beatbot` via pip/pipx. Runs librosa on their machine, POSTs the `Track` pkl to Cloud Run which stores features in Firestore.
- **Browser is display-only** — requests fresh cue predictions via the API on every track load; handles audio playback via the File System Access API. No Python in the browser.
- **No prediction caching** — predictions are computed fresh on every request against the currently deployed model. Rolling out a new model instantly improves results for every user, every track.
- **Free tier only** — Firebase Auth, Firestore, Firebase Hosting, and Cloud Run all operate within free-tier limits for personal use.

---

## Architecture

```
┌────────────────────────── USER MACHINE ──────────────────────────────────────┐
│                                                                               │
│  pip install beatbot  (or pipx install beatbot)                              │
│                                                                               │
│  beatbot login                   # Firebase email/password → ~/.beatbot/     │
│  beatbot extract "/Music/House"  # librosa → Track pkl → POST /predict       │
│  beatbot extract "/Music/Techno" # multiple folders supported                │
│                                                                               │
│  ┌────────────────────────── BROWSER ───────────────────────────────────┐    │
│  │  Firebase Auth SDK  (login / session token)                          │    │
│  │  File System Access API  →  Web Audio API  (playback only)           │    │
│  │  POST /predict/{id} on every track load  →  always-fresh cue points  │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
          │ POST /predict/{track_id}              GET /features/{track_id}
          │   Authorization: Bearer <firebase_id_token>  (status check only)
          │   Content-Type: application/octet-stream
          │   Body: pickle.dumps(Track)   (~150–300 KB)   [CLI upload]
          │          — or —
          │   Body: empty                                 [web app predict]
          │
          ▼
┌───────────────────────── GOOGLE CLOUD  (all free tier) ──────────────────────┐
│                                                                               │
│  Firebase Auth        —  user accounts + ID tokens                           │
│  Firestore            —  library metadata, feature store (pkl bytes), queue  │
│  Cloud Run            —  BeatBot API (FastAPI + LightGBM baked in image)     │
│    POST /predict/{id} —  with body:  store pkl in Firestore → run model      │
│                       —  no body:   fetch pkl from Firestore → run model     │
│    GET  /features/{id}—  check if features have been uploaded (no inference) │
│  Firebase Hosting     —  React/Vite static frontend                           │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## User Flow

1. **Create account** — Firebase Auth email/password via the web app.

2. **Link music folder** — Browser calls `showDirectoryPicker()`. The user picks their local MP3 directory; the handle is persisted in IndexedDB. The frontend walks the handle and builds the library list immediately (no features needed yet).

3. **Install the CLI** — Install from PyPI:

   ```bash
   pipx install beatbot   # or: pip install beatbot
   beatbot login
   beatbot extract "/path/to/Music"
   ```

   Multiple folders can be passed in a single command.

4. **Local extraction** — For each unseen track the CLI:
   - Runs `librosa` feature extraction locally (~15–30 s per track).
   - Pickles the `Track` object (~150–300 KB).
   - POSTs it to `POST /predict/{track_id}` on Cloud Run with the Firebase ID token.
   - The server stores the raw features in Firestore (`users/{uid}/features/{track_id}`) and returns a fresh prediction.

5. **Fresh prediction on every load** — When the web app selects a track, it calls `POST /predict/{track_id}` (no body). Cloud Run fetches the stored feature pkl from Firestore and runs the **currently deployed model** fresh every time. There is no prediction cache — opening the web app after a model update automatically gives improved cue points for all your tracks.

6. **Model updates propagate instantly** — Deploy a new model to Cloud Run. Every subsequent predict call — for every user, every track — uses the new model. No stale cache to invalidate. Audio is read from the local file system via the File System Access API — **audio never leaves the machine.**

7. **Adding more folders** — Run `beatbot extract "/new/folder"` at any time. Tracks already uploaded are skipped automatically (check status with `beatbot status "/folder"`). Use `--force` to re-upload features (e.g. after re-ripping a track).

---

## The `beatbot` pip Package

### Package layout

```
beatbot/                  ← pip-installable (pyproject.toml)
  __init__.py
  cli.py                  ← entry point: beatbot login / extract / status
  track.py                ← Track dataclass
  extractor/
    __init__.py
    extractor.py          ← Extractor class (uses librosa, scipy, numpy)
```

### CLI commands

| Command                                  | Description                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `beatbot login`                          | Firebase email/password sign-in; token saved to `~/.beatbot/credentials.json` |
| `beatbot extract <folder> [<folder2> …]` | Extract + upload features for new tracks; skips already-uploaded ones         |
| `beatbot extract <folder> --force`       | Re-upload features for all tracks even if already stored                      |
| `beatbot status <folder> [<folder2> …]`  | Show uploaded vs pending counts without extracting                            |

### Installation

```bash
# recommended (isolated env, auto-updates with pipx upgrade beatbot)
pipx install beatbot

# or plain pip
pip install beatbot
```

**Dependencies** installed automatically: `librosa`, `numpy`, `scipy`, `tqdm`.  
Only `python >= 3.10` required.

### Configuration

No config file needed. API URL and Firebase key are baked into the package (they are client-side public values — the same key is already embedded in the web app JS bundle).

Override via env var if needed:

```bash
BEATBOT_API_URL=http://localhost:8000 beatbot extract "/folder"
```

---

## Free Tier Limits (Personal Traffic)

| Service            | Free allowance              | Expected personal usage                         |
| ------------------ | --------------------------- | ----------------------------------------------- |
| Firebase Auth      | 10,000 MAU                  | 1–5 users                                       |
| Firestore reads    | 50,000 / day                | ~10–50 / session (feature fetch per track load) |
| Firestore writes   | 20,000 / day                | ~10 / session (feature upload, first time only) |
| Firestore storage  | 1 GB                        | ~150 MB (feature pkls @ ~150 KB/track)          |
| Cloud Run requests | 2,000,000 / month           | < 500 / month                                   |
| Cloud Run compute  | 360,000 GB-s memory / month | < 2,000 GB-s / month                            |
| Firebase Hosting   | 10 GB bandwidth / month     | < 50 MB / month                                 |
| Artifact Registry  | 500 MB / month              | ~300 MB (one Docker image)                      |

**Verdict: $0/month at personal usage.**

---

## Cloud Run API

### `POST /predict/{track_id}`

- **Auth**: `Authorization: Bearer <firebase_id_token>`
- **Body (CLI upload)**: raw bytes — `pickle.dumps(Track)` — stores features in Firestore, runs model, returns JSON cue result
- **Body (empty, web app)**: fetches stored features from Firestore, runs model fresh, returns JSON cue result
- **No prediction cache** — every call runs model inference against the stored features

```python
@router.post("/predict/{track_id}")
def predict(track_id: str, request: Request, uid: str = Depends(verify_token)):
    body = request.body()

    if body:
        track: Track = pickle.loads(body)
        set_features(uid, track_id, body)  # store raw features in Firestore
    else:
        pkl_bytes = get_features(uid, track_id)  # fetch from Firestore
        if not pkl_bytes:
            raise HTTPException(404, "Run `beatbot extract` first")
        track = pickle.loads(pkl_bytes)

    # Always run the current model — no prediction cache
    cues = app_state.predict_cues(track)
    return PredictResponse(**cues)
```

### `GET /features/{track_id}`

- **Auth**: `Authorization: Bearer <firebase_id_token>`
- **Body**: none
- **Response**: `{"track_id": "...", "uploaded": true|false}`
- Used by `beatbot status` to check upload state efficiently without triggering model inference.

### Image — what's baked in

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements-api.txt .
RUN pip install --no-cache-dir -r requirements-api.txt
COPY src/ ./src/
COPY data/models/run_20260218_231046/ ./data/models/run_20260218_231046/
ENV PORT=8080
CMD ["uvicorn", "src.api.main:app", "--host", "0.0.0.0", "--port", "8080"]
```

`requirements-api.txt` contains only the server-side subset — `librosa`, `scipy`, and `tqdm` are **not** in the Cloud Run image (extraction runs on the user's machine):

```
numpy>=1.26.0,<2.4.0
pandas>=2.2.0,<3.0.0
scikit-learn>=1.4.0
lightgbm>=4.6.0,<5.0.0
fastapi>=0.115.0,<1.0.0
uvicorn[standard]>=0.30.0,<1.0.0
firebase-admin>=6.5.0,<7.0.0
```

### CORS

Both Firebase Hosting domains are allowed:

```python
# src/api/main.py
origins = [
    "https://beatbot-35280.web.app",
    "https://beatbot-35280.firebaseapp.com",
]
extra = os.environ.get("CORS_EXTRA_ORIGIN", "")
if extra:
    origins += [o.strip() for o in extra.split(",") if o.strip()]
```

---

## Firestore Data Model

```
users/
  {uid}/
    library/
      {track_id}:
        track_id:   "Bicep - Glue"
        filename:   "Bicep - Glue.mp3"
        added_at:   <timestamp>

    features/
      {track_id}:
        pkl:        <bytes>          # raw pickle.dumps(Track) — ~150–300 KB
        updated_at: <timestamp>
        # Predictions are NOT stored — computed fresh on every /predict call.
        # This makes model upgrades instantaneous for all users.

    queue/
      order:         ["Bicep - Glue", "ARTBAT - Horizon", …]
      current_index: 0
```

No `.pkl` paths or bucket references. Feature pkl bytes live in Firestore; predictions are computed on Cloud Run on every request and never persisted.

---

## `firestore.rules`

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

---

## Deployment Steps

### One-time setup

```bash
# 1. Firebase project (already done: beatbot-35280)
firebase login
firebase use beatbot-35280

# 2. Enable Firestore rules
firebase deploy --only firestore:rules

# 3. Build Docker image and deploy Cloud Run
gcloud builds submit --tag gcr.io/beatbot-35280/beatbot-api
gcloud run deploy beatbot-api \
  --image gcr.io/beatbot-35280/beatbot-api \
  --region us-east4 \
  --platform managed \
  --allow-unauthenticated \
  --memory 1Gi \
  --min-instances 0 \
  --set-env-vars CORS_EXTRA_ORIGIN=https://beatbot-35280.web.app
```

### Frontend deploy

```bash
cd frontend
pnpm run build
firebase deploy --only hosting
```

### Updating the `beatbot` pip package

After changing `beatbot/cli.py`, `beatbot/extractor/`, or `beatbot/track.py`:

```bash
# bump version in pyproject.toml, then:
poetry build                                    # creates dist/beatbot-X.Y.Z-py3-none-any.whl
twine upload dist/*.whl dist/*.tar.gz           # publish to PyPI (avoids old binary in dist/)
```

Until published to PyPI, install directly from the repo:

```bash
pip install git+https://github.com/YOUR_USERNAME/BeatBot
# or share the wheel file:
pip install beatbot-0.1.0-py3-none-any.whl
```

---

## Known Risks & Mitigations

| Risk                         | Detail                                        | Mitigation                                                                            |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| CLI not installed            | User has Python but not yet installed beatbot | README and `beatbot.web.app` Library tab show `pipx install beatbot` instructions     |
| Python not installed         | User has no Python at all                     | Show `python.org` link; minimum Python 3.10 required                                  |
| Large library first-run      | 500 tracks × 20 s = ~3 h extraction time      | Already-processed tracks are skipped; can be run overnight / in batches               |
| Firebase client key exposure | Key baked into pip package and web app JS     | Intended — Firebase client keys are public; Firestore rules enforce UID-scoped access |
| Cloud Run cold start         | ~2–4 s on first request after idle period     | Acceptable for personal use; `--min-instances 1` eliminates it (~$5/month)            |
| Track ID collisions          | Two users with a file named "Track 01.mp3"    | Cues are namespaced under `users/{uid}/cues/` — no collision                          |
