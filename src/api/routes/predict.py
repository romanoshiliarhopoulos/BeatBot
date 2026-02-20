"""POST /predict/{track_id} — run cue-point prediction for one track."""
from fastapi import APIRouter, HTTPException
from typing import List, Optional
import numpy as np

from api.schemas import PredictResponse
from api.state import app_state

router = APIRouter()


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


@router.post("/predict/{track_id}", response_model=PredictResponse)
def predict(track_id: str):
    """
    Run BeatBotModel (or heuristic fallback) on the given track and return
    per-bar scores plus the selected entry / exit timestamps.
    """
    t = app_state.track_registry.get(track_id)
    if t is None:
        raise HTTPException(status_code=404, detail=f"Track '{track_id}' not found.")

    entry_sec, exit_sec, method, score_in, score_out = app_state.predict_cues(t)

    # Vocal presence: prefer confidence float, fall back to bool mask
    vocal = t.vocal_activity_confidence if t.vocal_activity_confidence is not None else t.vocal_mask

    return PredictResponse(
        track_id=track_id,
        num_bars=t.num_bars,
        bar_times=t.bars.tolist(),
        score_in=score_in,
        score_out=score_out,
        entry_sec=round(entry_sec, 3),
        exit_sec=round(exit_sec, 3),
        method=method,
        energy=_norm(t.energy_per_bar),
        bass_energy=_norm(t.low_band_energy),
        high_energy=_norm(t.high_band_energy),
        mid_energy=_norm(t.mid_band_energy),
        beat_strength=_norm(t.beat_strength),
        vocal_presence=_norm(vocal),
    )
