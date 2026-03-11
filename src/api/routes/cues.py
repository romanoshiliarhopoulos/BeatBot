"""PATCH /cues/{track_id} — override an entry or exit cue point."""
from __future__ import annotations

import io
import pickle

import numpy as np
from fastapi import APIRouter, Depends, HTTPException

from api.auth import DEV_UID, verify_token
from api.firestore_client import get_features, set_features
from api.schemas import CueEditRequest, CueEditResponse
from api.state import app_state
from api.ws_manager import manager

router = APIRouter()


# ── pickle remapper (same as predict.py — supports beatbot.track.Track) ───────

class _BeatBotUnpickler(pickle.Unpickler):
    _REMAP = {
        ("beatbot.track",               "Track"):     ("track",               "Track"),
        ("beatbot.extractor.extractor", "Extractor"): ("extractor.extractor", "Extractor"),
    }

    def find_class(self, module: str, name: str):
        module, name = self._REMAP.get((module, name), (module, name))
        return super().find_class(module, name)


def _unpickle(data: bytes):
    return _BeatBotUnpickler(io.BytesIO(data)).load()


# ── endpoint ───────────────────────────────────────────────────────────────────

@router.patch("/cues/{track_id}", response_model=CueEditResponse)
async def edit_cue(
    track_id: str,
    body: CueEditRequest,
    uid: str = Depends(verify_token),
):
    """
    Snap the requested timestamp to the nearest bar boundary, persist the
    updated Track pkl back to Firestore, and broadcast a cues.accepted event
    over WebSocket to all connected clients.
    """
    # ── Resolve Track object ──────────────────────────────────────────────────
    # In local-dev mode (SKIP_AUTH=true) tracks live in the in-memory registry;
    # in production they live in Firestore.
    use_registry = uid == DEV_UID

    if use_registry:
        track = app_state.track_registry.get(track_id)
        if track is None:
            raise HTTPException(
                status_code=404,
                detail=f"Track '{track_id}' not found in local registry.",
            )
    else:
        pkl_bytes = get_features(uid, track_id)
        if pkl_bytes is None:
            raise HTTPException(
                status_code=404,
                detail=f"Track '{track_id}' not found. Run `beatbot extract` first.",
            )
        # Deserialise (supports both beatbot.track.Track and track.Track)
        track = _unpickle(pkl_bytes)

    # Snap to nearest bar boundary
    bar_index  = int(np.argmin(np.abs(track.bars - body.timestamp_sec)))
    accepted_sec = float(track.bars[bar_index])

    # Apply override
    if body.cue_type == "entry":
        track.cue_in  = np.array([accepted_sec])
    else:
        track.cue_out = np.array([accepted_sec])

    # Persist: registry in dev, Firestore in production
    if use_registry:
        app_state.track_registry[track_id] = track
    else:
        set_features(uid, track_id, pickle.dumps(track))

    resp = CueEditResponse(
        track_id=track_id,
        cue_type=body.cue_type,
        accepted_sec=round(accepted_sec, 3),
        bar_index=bar_index,
    )

    # Broadcast to all WS clients so every open tab sees the update
    await manager.broadcast({
        "type":        "cues.accepted",
        "track_id":    track_id,
        "cue_type":    body.cue_type,
        "accepted_sec": resp.accepted_sec,
        "bar_index":   bar_index,
    })

    return resp
