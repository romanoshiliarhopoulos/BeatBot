"""POST /transition/early — trigger an immediate mix-out."""
from fastapi import APIRouter, Depends, HTTPException

from api.auth import verify_token
from api.schemas import EarlyTransitionRequest, EarlyTransitionResponse
from api.state import app_state
from api.ws_manager import manager

router = APIRouter()


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
