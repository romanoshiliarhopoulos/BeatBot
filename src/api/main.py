"""
BeatBot FastAPI server.

Run locally:
    SKIP_AUTH=true python src/api/main.py
  or
    SKIP_AUTH=true uvicorn src.api.main:app --reload --host 0.0.0.0 --port 8000

On Cloud Run:
    Firebase Admin SDK initialises automatically via Application Default
    Credentials.  No extra environment variables needed beyond what GCP injects.

The server:
  1. Optionally loads processed tracks from data/processed/*.pkl (local dev).
  2. Loads the latest trained model from data/models/run_*/ (baked into image).
  3. Exposes REST + WebSocket endpoints.
  4. Validates Firebase ID tokens on every request (except SKIP_AUTH=true).

CORS: localhost origins are always allowed.  Set CORS_EXTRA_ORIGIN env var to
additionally allow your Firebase Hosting domain in production, e.g.:
    CORS_EXTRA_ORIGIN=https://beatbot-35280.web.app
"""
from __future__ import annotations

import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Ensure src/ is on the path so project modules resolve
_SRC = Path(__file__).parent.parent
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from api.state import app_state  # noqa: E402  (must come after sys.path tweak)
from api.auth import _ensure_app as _ensure_firebase  # noqa: E402
from api.routes import (         # noqa: E402
    cues,
    live_session,
    mixes,
    predict,
    queue,
    session,
    tracks,
    transition,
    upload,
)
from api.session_state import session_store  # noqa: E402

# ── logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("beatbot.main")


# ── lifespan (startup / shutdown) ────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Starting BeatBot API…")

    # Initialise Firebase Admin SDK (uses ADC on Cloud Run, SKIP_AUTH locally).
    import os
    if os.getenv("SKIP_AUTH", "false").lower() not in ("true", "1", "yes"):
        try:
            _ensure_firebase()
            log.info("  ✓  Firebase Admin SDK initialised.")
        except Exception as exc:
            log.warning("  ⚠  Firebase init failed (set SKIP_AUTH=true for local dev): %s", exc)

    n_tracks = app_state.load_tracks()
    log.info("  ✓  %d tracks loaded", n_tracks)

    ok = app_state.load_model()
    if ok:
        log.info("  ✓  Model loaded.")
    else:
        log.warning("  ⚠  No model found — heuristic cue detection will be used.")

    session_store.start_timeout_checker()

    yield  # server is live

    session_store.stop_timeout_checker()
    log.info("Shutting down BeatBot API.")


# ── app ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="BeatBot API",
    version="0.1.0",
    description="ML-powered DJ cue point prediction and queue management.",
    lifespan=lifespan,
)

import os as _os

# Always allow any localhost/127.0.0.1 origin regardless of port (covers all
# Vite dev server ports: 5173, 5174, 5175 …).
# Add your Firebase Hosting domain via the CORS_EXTRA_ORIGIN env var, e.g.:
#   CORS_EXTRA_ORIGIN=https://beatbot-35280.web.app
CORS_ORIGINS = []
CORS_ORIGIN_REGEX = r"http://(localhost|127\.0\.0\.1)(:\d+)?"

# CORS_EXTRA_ORIGIN can be a comma-separated list of origins, e.g.:
#   https://beatbot-35280.web.app,https://beatbot-35280.firebaseapp.com
_extra = _os.getenv("CORS_EXTRA_ORIGIN", "").strip()
for _origin in _extra.split(","):
    _origin = _origin.strip()
    if _origin:
        CORS_ORIGINS.append(_origin)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_origin_regex=CORS_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── routes ────────────────────────────────────────────────────────────────────

app.include_router(tracks.router,     tags=["Library"])
app.include_router(mixes.router,      tags=["Mixes"])
app.include_router(predict.router,    tags=["Prediction"])
app.include_router(cues.router,       tags=["Cues"])
app.include_router(queue.router,      tags=["Queue"])
app.include_router(upload.router,     tags=["Upload"])
# audio.py is intentionally not mounted: audio is served from the browser
# via the File System Access API (no server-side audio streaming needed).
app.include_router(transition.router, tags=["Playback"])
app.include_router(session.router,    tags=["WebSocket"])
app.include_router(live_session.router, tags=["Live Sessions"])


@app.get("/", include_in_schema=False)
def root():
    return {
        "service": "BeatBot API",
        "tracks":  len(app_state.track_registry),
        "model":   app_state.model_version or ("heuristic" if app_state.model is None else "loaded"),
        "docs":    "/docs",
    }


@app.get("/health", tags=["Meta"])
def health():
    return {
        "status":       "ok",
        "tracks":       len(app_state.track_registry),
        "model":        app_state.model is not None,
        "model_version": app_state.model_version,
        "queues_total_tracks": sum(len(u.queue) for u in app_state.users.values()),
        "ws_clients":   __import__("api.ws_manager", fromlist=["manager"]).manager.connection_count,
    }


# ── entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "api.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        reload_dirs=[str(_SRC)],
        app_dir=str(_SRC),
        log_level="info",
    )
