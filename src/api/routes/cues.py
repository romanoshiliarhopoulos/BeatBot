"""PATCH /cues/{track_id} — override an entry or exit cue point."""
from fastapi import APIRouter, HTTPException

from api.schemas import CueEditRequest, CueEditResponse
from api.state import app_state
from api.ws_manager import manager

router = APIRouter()


@router.patch("/cues/{track_id}", response_model=CueEditResponse)
async def edit_cue(track_id: str, body: CueEditRequest):
    """
    Snap the requested timestamp to the nearest bar boundary, persist it to
    the .pkl file, update the queue if the track is currently queued, and
    broadcast a cues.accepted event over WebSocket to all connected clients.
    """
    try:
        accepted_sec, bar_index = app_state.apply_cue_override(
            track_id=track_id,
            cue_type=body.cue_type,
            timestamp_sec=body.timestamp_sec,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    resp = CueEditResponse(
        track_id=track_id,
        cue_type=body.cue_type,
        accepted_sec=round(accepted_sec, 3),
        bar_index=bar_index,
    )

    # Broadcast to all WS clients so every open tab sees the update
    await manager.broadcast({
        "type": "cues.accepted",
        "track_id": track_id,
        "cue_type": body.cue_type,
        "accepted_sec": resp.accepted_sec,
        "bar_index": bar_index,
    })

    return resp
