"""
POST /predict/{track_id}  — run cue-point prediction for one track.

Two calling modes
──────────────────
 Upload (CLI):   client POSTs pickled Track bytes as the raw body
                 (Content-Type: application/octet-stream).  The server
                 stores the raw features in Firestore and returns a fresh
                 PredictResponse.  No prediction result is ever cached.

 Predict (web):  body is empty; server fetches the stored feature pkl from
                 Firestore, deserialises it, and runs the current model.

Why no prediction caching?
──────────────────────────
Caching predictions means users see stale results after a model update.
By storing only the raw extracted *features* (stable, device-agnostic) and
running model inference on every request, deploying a new model to Cloud Run
automatically improves results for every user, every track, immediately.

This also enables per-request model customisation in future: pass a JSON
`weights` query parameter to influence scoring without re-extracting audio.

Optional query parameters
─────────────────────────
 weights (str, JSON, optional):
     Reserved for future per-request model weight overrides, e.g.
     {"energy": 1.5, "bass": 0.8}.  Ignored in the current release.
"""
from __future__ import annotations

import io
import json
import logging
import pickle
from typing import Dict, List, Optional

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, Request

from api.auth import DEV_UID, verify_token
from api.firestore_client import get_features, set_features, set_library_track
from api.schemas import PredictResponse
from api.state import app_state

log    = logging.getLogger("beatbot.predict")
router = APIRouter()


# ── pickle module-path remapper ───────────────────────────────────────────────
# The pip-installed CLI pickles Track as `beatbot.track.Track`.
# The server only has it as `track.Track` (src/track.py).
# This custom Unpickler transparently bridges the two.

class _BeatBotUnpickler(pickle.Unpickler):
    _REMAP = {
        ("beatbot.track",            "Track"):     ("track",            "Track"),
        ("beatbot.extractor.extractor", "Extractor"): ("extractor.extractor", "Extractor"),
    }

    def find_class(self, module: str, name: str):
        module, name = self._REMAP.get((module, name), (module, name))
        return super().find_class(module, name)


def _unpickle(data: bytes):
    """Deserialise a Track pkl regardless of whether it was pickled by the
    pip package (beatbot.track.Track) or from source (track.Track)."""
    return _BeatBotUnpickler(io.BytesIO(data)).load()


def _norm(arr) -> Optional[List[float]]:
    """Min-max normalise a numpy array to [0, 1]. Returns None if input is None."""
    if arr is None:
        return None
    a = np.asarray(arr, dtype=float)
    if a.size == 0:
        return []
    mn, mx = a.min(), a.max()
    if mx - mn < 1e-9:
        return [0.5] * len(a)
    return ((a - mn) / (mx - mn)).tolist()


def _write_library_stub(uid: str, track_id: str, t) -> None:
    """Write / refresh the library metadata stub for a track in Firestore."""
    _NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    key_name: Optional[str] = None
    if getattr(t, "key_tonic", None) is not None and getattr(t, "key_scale", None) is not None:
        note = _NOTE_NAMES[t.key_tonic % 12]
        key_name = f"{note}{'m' if t.key_scale == 'minor' else ''}"
    set_library_track(uid, track_id, {
        "track_id":       track_id,
        "duration":       round(float(t.duration), 2),
        "tempo":          round(float(t.tempo), 1),
        "key":            key_name,
        "camelot":        getattr(t, "camelot_code", None),
        "num_bars":       int(t.num_bars),
        "has_cue_labels": bool(getattr(t, "has_cue_labels", False)),
        "collection":     "custom",
    })


@router.get("/features/{track_id}", tags=["Prediction"])
async def feature_status(
    track_id: str,
    uid: str = Depends(verify_token),
):
    """
    Lightweight check: returns {"track_id": ..., "uploaded": bool}.
    Used by the CLI `beatbot status` command to avoid running full model
    inference just to check whether features have been uploaded.
    """
    uploaded = False
    if uid != DEV_UID:
        uploaded = get_features(uid, track_id) is not None
    else:
        uploaded = track_id in app_state.track_registry
    return {"track_id": track_id, "uploaded": uploaded}


@router.post("/predict/{track_id}", response_model=PredictResponse)
async def predict(
    track_id: str,
    request: Request,
    uid: str = Depends(verify_token),
    weights: Optional[str] = Query(
        default=None,
        description=(
            "Optional JSON object of per-feature weight overrides "
            "(e.g. '{\"energy\": 1.5, \"bass\": 0.8}'). "
            "Reserved for future model tuning — ignored in current release."
        ),
    ),
):
    """
    Predict entry / exit cue points for a track.

    - If the request body contains bytes: store the pkl features in Firestore,
      run the current model, return a fresh PredictResponse.
    - If the body is empty: fetch stored features from Firestore, run the
      current model fresh, return a PredictResponse.

    Predictions are *never* cached.  Every call runs model inference against
    the features on record, so rolling out a new model version applies
    instantly to all users.
    """
    # ── 1. Parse optional model weights ──────────────────────────────────────
    weight_map: Dict[str, float] = {}
    if weights:
        try:
            weight_map = json.loads(weights)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="weights must be a valid JSON object.")

    # ── 2. Read raw body ──────────────────────────────────────────────────────
    body: bytes = await request.body()

    # ── 3. Resolve Track object ───────────────────────────────────────────────
    if body:
        # CLI sent fresh pkl bytes — store features, then deserialise.
        try:
            t = _unpickle(body)
            t.track_id = track_id
        except Exception as exc:
            log.error("[%s] Failed to deserialise Track pkl: %s", track_id, exc)
            raise HTTPException(status_code=400, detail="Invalid Track pickle payload.")

        # Persist raw features so the web app can predict without a body.
        if uid != DEV_UID:
            set_features(uid, track_id, body)
            log.info("[%s] Features stored for uid=%s (%d bytes)", track_id, uid, len(body))
            _write_library_stub(uid, track_id, t)

    else:
        # No body — fetch stored features from Firestore, or fall back to
        # the in-memory registry (local dev).
        pkl_bytes: Optional[bytes] = None
        if uid != DEV_UID:
            pkl_bytes = get_features(uid, track_id)

        if pkl_bytes:
            try:
                t = _unpickle(pkl_bytes)
                t.track_id = track_id
                log.info("[%s] Features loaded from Firestore for uid=%s", track_id, uid)
                _write_library_stub(uid, track_id, t)
            except Exception as exc:
                log.error("[%s] Failed to deserialise stored features: %s", track_id, exc)
                raise HTTPException(status_code=500, detail="Stored features are corrupt.")
        else:
            # Local dev / freshly-registered track not yet uploaded
            t = app_state.track_registry.get(track_id)
            if t is None:
                raise HTTPException(
                    status_code=404,
                    detail=(
                        f"No features found for '{track_id}'. "
                        "Run `beatbot extract` to upload your track features first."
                    ),
                )

    # ── 4. Run model inference (always fresh — no prediction cache) ───────────
    log.info("[%s] Running model inference (uid=%s)", track_id, uid)
    entry_sec, exit_sec, method, score_in, score_out = app_state.predict_cues(
        t, weights=weight_map or None
    )

    vocal = (
        t.vocal_activity_confidence
        if t.vocal_activity_confidence is not None
        else t.vocal_mask
    )

    return PredictResponse(
        track_id=track_id,
        num_bars=t.num_bars,
        bar_times=t.bars.tolist(),
        score_in=score_in,
        score_out=score_out,
        entry_sec=round(entry_sec, 3),
        exit_sec=round(exit_sec, 3),
        method=method,
        model_version=app_state.model_version,
        energy=_norm(t.energy_per_bar),
        bass_energy=_norm(t.low_band_energy),
        high_energy=_norm(t.high_band_energy),
        mid_energy=_norm(t.mid_band_energy),
        beat_strength=_norm(t.beat_strength),
        vocal_presence=_norm(vocal),
    )
