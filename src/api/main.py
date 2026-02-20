"""
BeatBot FastAPI server.

Run:
    python src/api/main.py
  or
    uvicorn src.api.main:app --reload --host 0.0.0.0 --port 8000

The server:
  1. Loads all processed tracks from data/processed/*.pkl
  2. Loads the latest trained model from data/models/run_*/
  3. Exposes REST endpoints + one WebSocket channel

CORS is configured to allow any localhost origin during development.
For production, restrict CORS_ORIGINS to your actual frontend domain.
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
from api.routes import (         # noqa: E402
    audio,
    cues,
    predict,
    queue,
    session,
    tracks,
    transition,
)

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

    n_tracks = app_state.load_tracks()
    log.info("  ✓  %d tracks loaded", n_tracks)

    ok = app_state.load_model()
    if ok:
        log.info("  ✓  Model loaded.")
    else:
        log.warning("  ⚠  No model found — heuristic cue detection will be used.")

    yield  # server is live

    log.info("Shutting down BeatBot API.")


# ── app ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="BeatBot API",
    version="0.1.0",
    description="ML-powered DJ cue point prediction and queue management.",
    lifespan=lifespan,
)

# Allow the React dev server (localhost:3000 / 5173) and any local origin
CORS_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── routes ────────────────────────────────────────────────────────────────────

app.include_router(tracks.router,     tags=["Library"])
app.include_router(predict.router,    tags=["Prediction"])
app.include_router(cues.router,       tags=["Cues"])
app.include_router(queue.router,      tags=["Queue"])
app.include_router(audio.router,      tags=["Audio"])
app.include_router(transition.router, tags=["Playback"])
app.include_router(session.router,    tags=["WebSocket"])


@app.get("/", include_in_schema=False)
def root():
    return {
        "service": "BeatBot API",
        "tracks":  len(app_state.track_registry),
        "model":   "loaded" if app_state.model is not None else "heuristic",
        "docs":    "/docs",
    }


@app.get("/health", tags=["Meta"])
def health():
    return {
        "status":  "ok",
        "tracks":  len(app_state.track_registry),
        "model":   app_state.model is not None,
        "queue":   len(app_state.queue),
        "ws_clients": __import__("api.ws_manager", fromlist=["manager"]).manager.connection_count,
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
