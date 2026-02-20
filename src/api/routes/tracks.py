"""GET /tracks — return full library metadata."""
from fastapi import APIRouter
from typing import List

from api.schemas import TrackMeta
from api.state import app_state

router = APIRouter()


@router.get("/tracks", response_model=List[TrackMeta])
def get_tracks():
    """Return metadata for every track in the registry."""
    out: List[TrackMeta] = []
    for t in app_state.track_registry.values():
        key_name = None
        if t.key_tonic is not None and t.key_scale is not None:
            note = ["C", "C#", "D", "D#", "E", "F",
                    "F#", "G", "G#", "A", "A#", "B"][t.key_tonic % 12]
            key_name = f"{note}{'m' if t.key_scale == 'minor' else ''}"

        collection = "m-djcue" if t.source.upper().replace("_", "-") == "M-DJCUE" else "custom"
        out.append(TrackMeta(
            track_id=t.track_id,
            duration=round(t.duration, 2),
            tempo=round(t.tempo, 1),
            key=key_name,
            camelot=t.camelot_code,
            num_bars=t.num_bars,
            has_cue_labels=t.has_cue_labels,
            collection=collection,
        ))

    return sorted(out, key=lambda x: x.track_id.lower())
