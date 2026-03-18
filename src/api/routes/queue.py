"""
Queue management routes.

GET    /queue                – current queue state
POST   /queue                – add tracks (runs predict for each)
PATCH  /queue/reorder        – drag-to-reorder
DELETE /queue/{position}     – remove one slot
DELETE /queue                – clear entire queue
"""
from fastapi import APIRouter, Depends, HTTPException

from api.auth import verify_token
from api.schemas import (
    AddToQueueRequest,
    QueueState,
    ReorderRequest,
)
from api.state import app_state
from api.ws_manager import manager

router = APIRouter()


def _queue_state(uid: str) -> QueueState:
    user_state = app_state.get_user_state(uid)
    return QueueState(
        current_index=user_state.current_index,
        tracks=app_state.queue_as_list(uid),
    )


async def _broadcast_queue(uid: str):
    await manager.broadcast_to_user(uid, {
        "type": "queue.updated",
        "tracks": app_state.queue_as_list(uid),
    })


# ── GET /queue ────────────────────────────────────────────────────────────────

@router.get("/queue", response_model=QueueState)
def get_queue(uid: str = Depends(verify_token)):
    return _queue_state(uid)


# ── POST /queue ───────────────────────────────────────────────────────────────

@router.post("/queue", response_model=QueueState)
async def add_to_queue(body: AddToQueueRequest, uid: str = Depends(verify_token)):
    """
    Add one or more tracks to the end of the queue.
    Unknown track IDs (browser-extracted, not yet in the server registry) are
    accepted with placeholder cues so the browser can refine them after extraction.
    """
    app_state.add_tracks(uid, body.track_ids)
    await _broadcast_queue(uid)
    return _queue_state(uid)


# ── PATCH /queue/reorder ──────────────────────────────────────────────────────

@router.patch("/queue/reorder", response_model=QueueState)
async def reorder_queue(body: ReorderRequest, uid: str = Depends(verify_token)):
    user_state = app_state.get_user_state(uid)
    q = user_state.queue
    n = len(q)
    if not (0 <= body.from_position < n and 0 <= body.to_position < n):
        raise HTTPException(status_code=400, detail="Position out of range.")

    item = q.pop(body.from_position)
    q.insert(body.to_position, item)

    # Adjust current_index if needed to keep it pointing to the same entry
    ci = user_state.current_index
    if body.from_position == ci:
        user_state.current_index = body.to_position
    elif body.from_position < ci <= body.to_position:
        user_state.current_index -= 1
    elif body.to_position <= ci < body.from_position:
        user_state.current_index += 1

    await _broadcast_queue(uid)
    return _queue_state(uid)


# ── DELETE /queue/{position} ──────────────────────────────────────────────────

@router.delete("/queue/{position}", response_model=QueueState)
async def remove_from_queue(position: int, uid: str = Depends(verify_token)):
    user_state = app_state.get_user_state(uid)
    q = user_state.queue
    if not (0 <= position < len(q)):
        raise HTTPException(status_code=400, detail="Position out of range.")

    q.pop(position)

    # Keep current_index valid
    if user_state.current_index >= len(q):
        user_state.current_index = max(0, len(q) - 1)

    await _broadcast_queue(uid)
    return _queue_state(uid)


# ── DELETE /queue ─────────────────────────────────────────────────────────────

@router.delete("/queue", response_model=QueueState)
async def clear_queue(uid: str = Depends(verify_token)):
    user_state = app_state.get_user_state(uid)
    user_state.queue.clear()
    user_state.current_index = 0
    await _broadcast_queue(uid)
    return _queue_state(uid)
