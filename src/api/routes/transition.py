"""Transition endpoints — suggest optimal transition type & trigger early mix."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException

from api.auth import DEV_UID, verify_token
from api.firestore_client import get_features
from api.schemas import (
    EarlyTransitionRequest,
    EarlyTransitionResponse,
    TransitionConfig,
    TransitionSuggestRequest,
)
from api.state import app_state
from api.ws_manager import manager
from transition_strategy import compute_transition_config

log = logging.getLogger("beatbot.transition")
router = APIRouter()


# ── helpers ────────────────────────────────────────────────────────────────

def _norm(arr) -> list[float] | None:
    """Min-max normalise a numpy array to [0, 1]."""
    if arr is None:
        return None
    import numpy as np
    a = np.asarray(arr, dtype=float)
    if a.size == 0:
        return []
    mn, mx = a.min(), a.max()
    if mx - mn < 1e-9:
        return [0.5] * len(a)
    return ((a - mn) / (mx - mn)).tolist()


def _load_track(uid: str, track_id: str):
    """Load a Track object from the in-memory registry or Firestore."""
    # Try in-memory first (local dev / already loaded)
    t = app_state.track_registry.get(track_id)
    if t is not None:
        return t

    # Fetch from Firestore
    if uid != DEV_UID:
        pkl_bytes = get_features(uid, track_id)
        if pkl_bytes:
            from api.routes.predict import _unpickle
            t = _unpickle(pkl_bytes)
            t.track_id = track_id
            return t

    return None


def _bar_index(bar_times, sec: float) -> int:
    """Find the bar index closest to the given timestamp."""
    if bar_times is None or len(bar_times) == 0:
        return 0
    best = 0
    best_dist = abs(float(bar_times[0]) - sec)
    for i in range(1, len(bar_times)):
        d = abs(float(bar_times[i]) - sec)
        if d < best_dist:
            best_dist = d
            best = i
    return best


# ── POST /transition/suggest ──────────────────────────────────────────────

@router.post("/transition/suggest", response_model=TransitionConfig)
async def suggest_transition(
    body: TransitionSuggestRequest,
    uid: str = Depends(verify_token),
):
    """
    Given two track IDs and their cue points, return the recommended
    transition type and parameters.  The frontend uses this to set the
    dropdown default, but the user can override.
    """
    out_track = _load_track(uid, body.out_track_id)
    in_track = _load_track(uid, body.in_track_id)

    if out_track is None:
        raise HTTPException(status_code=404, detail=f"Features not found for '{body.out_track_id}'")
    if in_track is None:
        raise HTTPException(status_code=404, detail=f"Features not found for '{body.in_track_id}'")

    out_exit_bar = _bar_index(out_track.bars, body.out_exit_sec)
    in_entry_bar = _bar_index(in_track.bars, body.in_entry_sec)

    out_vocal = (
        out_track.vocal_activity_confidence
        if out_track.vocal_activity_confidence is not None
        else out_track.vocal_mask
    )
    in_vocal = (
        in_track.vocal_activity_confidence
        if in_track.vocal_activity_confidence is not None
        else in_track.vocal_mask
    )

    cfg = compute_transition_config(
        out_energy=_norm(out_track.energy_per_bar),
        out_bass=_norm(out_track.low_band_energy),
        out_vocal=_norm(out_vocal),
        out_beat_strength=_norm(out_track.beat_strength),
        out_exit_bar=out_exit_bar,
        in_energy=_norm(in_track.energy_per_bar),
        in_bass=_norm(in_track.low_band_energy),
        in_vocal=_norm(in_vocal),
        in_beat_strength=_norm(in_track.beat_strength),
        in_entry_bar=in_entry_bar,
        out_tempo=float(out_track.tempo),
        fade_secs=body.fade_secs,
    )

    return TransitionConfig(**cfg)


# ── POST /transition/early ────────────────────────────────────────────────

@router.post("/transition/early", response_model=EarlyTransitionResponse)
async def early_transition(body: EarlyTransitionRequest, uid: str = Depends(verify_token)):
    """
    Advance the queue one step and return the next track's cue data so the
    frontend can start the Web Audio API crossfade immediately.

    Also broadcasts a playback.track_changed event to all WS clients.
    """
    user_state = app_state.get_user_state(uid)
    q   = user_state.queue
    ci  = user_state.current_index
    nxt = ci + 1

    if nxt >= len(q):
        raise HTTPException(status_code=409, detail="No next track in queue.")

    prev_entry = q[ci]
    next_entry = q[nxt]
    user_state.current_index = nxt
    user_state.playback.elapsed_sec = next_entry.entry_sec

    next_track = app_state.track_registry.get(next_entry.track_id)
    duration   = next_track.duration if next_track else 0.0

    await manager.broadcast_to_user(uid, {
        "type":            "playback.track_changed",
        "prev_track_id":   prev_entry.track_id,
        "curr_track_id":   next_entry.track_id,
        "curr_entry_sec":  next_entry.entry_sec,
        "curr_exit_sec":   next_entry.exit_sec,
        "queue_position":  nxt,
    })

    return EarlyTransitionResponse(
        next_track_id=next_entry.track_id,
        entry_sec=next_entry.entry_sec,
        exit_sec=next_entry.exit_sec,
        fade_secs=body.fade_secs,
    )
