"""
Live session routes — DJ session management, audience access, song requests.

DJ-authenticated endpoints:
    POST   /sessions              – create a new live session
    GET    /sessions/active       – get DJ's current active session (for recovery)
    DELETE /sessions/{id}         – end a session
    GET    /sessions/{id}/requests – list pending requests
    PATCH  /sessions/{id}/requests/{rid} – accept or deny a request
    GET    /sessions/history      – past sessions with analytics

Public (no auth) endpoints:
    GET    /sessions/{id}         – get session state (audience)
    GET    /sessions/{id}/library – search DJ's library
    POST   /sessions/{id}/requests – submit a song request
    WS     /ws/live/{id}          – audience real-time WebSocket
"""
from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect

from api.auth import verify_token
from api.schemas import (
    CreateSessionResponse,
    SessionState,
    SessionSummary,
    SongRequestCreate,
    SongRequestResponse,
    ResolveRequestBody,
    QueueItem,
    TrackMeta,
)
from api.state import app_state
from api.session_state import session_store, SongRequest, _nanoid
from api.ws_manager import manager

log = logging.getLogger("beatbot.routes.live_session")
router = APIRouter()


# ── helpers ──────────────────────────────────────────────────────────────────

def _session_url(session_id: str) -> str:
    """Build the audience-facing URL.  In dev this is localhost."""
    return f"/live/{session_id}"


def _queue_items_for_session(uid: str) -> list[dict]:
    """Return serialisable queue items for a DJ's session."""
    return app_state.queue_as_list(uid)


def _session_state_response(session_id: str) -> SessionState:
    session = session_store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    queue_items = _queue_items_for_session(session.dj_uid)
    return SessionState(
        session_id=session.session_id,
        active=session.active,
        dj_connected=session.dj_connected,
        current_track_id=session.current_track_id,
        current_index=session.current_index,
        elapsed_sec=session.elapsed_sec,
        queue=[QueueItem(**q) for q in queue_items],
        created_at=session.created_at,
    )


# ── DJ endpoints (authenticated) ────────────────────────────────────────────

@router.post("/sessions", response_model=CreateSessionResponse)
async def create_session(uid: str = Depends(verify_token)):
    session = session_store.create_session(uid)
    session_store.start_timeout_checker()

    # Broadcast to DJ's WS clients
    await manager.broadcast_to_user(uid, {
        "type": "session.start",
        "session_id": session.session_id,
    })

    return CreateSessionResponse(
        session_id=session.session_id,
        session_url=_session_url(session.session_id),
        created_at=session.created_at,
    )


@router.get("/sessions/active", response_model=SessionState)
def get_active_session(uid: str = Depends(verify_token)):
    session = session_store.get_active_session_for_dj(uid)
    if not session:
        raise HTTPException(status_code=404, detail="No active session")
    return _session_state_response(session.session_id)


@router.delete("/sessions/{session_id}")
async def end_session(session_id: str, uid: str = Depends(verify_token)):
    session = session_store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.dj_uid != uid:
        raise HTTPException(status_code=403, detail="Not your session")

    session_store.end_session(session_id)

    # Notify audience
    await session_store.audience_ws.broadcast(session_id, {"type": "session.end"})
    # Notify DJ
    await manager.broadcast_to_user(uid, {"type": "session.end"})

    return {"status": "ended", "session_id": session_id}


@router.get("/sessions/history", response_model=list[SessionSummary])
def get_session_history(uid: str = Depends(verify_token)):
    sessions = session_store.get_history(uid)
    return [
        SessionSummary(
            session_id=s.session_id,
            created_at=s.created_at,
            ended_at=s.ended_at,
            duration_sec=s.analytics.duration_sec,
            peak_listeners=s.analytics.peak_listeners,
            unique_listeners=s.analytics.unique_listeners,
            total_requests=s.analytics.total_requests,
            accepted_requests=s.analytics.accepted_requests,
            denied_requests=s.analytics.denied_requests,
            tracks_played=s.analytics.tracks_played,
        )
        for s in sorted(sessions, key=lambda s: s.created_at, reverse=True)
    ]


@router.get("/sessions/{session_id}/requests", response_model=list[SongRequestResponse])
def get_requests(session_id: str, uid: str = Depends(verify_token)):
    session = session_store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.dj_uid != uid:
        raise HTTPException(status_code=403, detail="Not your session")

    pending = session_store.get_pending_requests(session_id)
    return [
        SongRequestResponse(
            request_id=r.request_id,
            session_id=r.session_id,
            display_name=r.display_name,
            source=r.source,
            track_id=r.track_id,
            youtube_url=r.youtube_url,
            query=r.query,
            status=r.status,
            created_at=r.created_at,
        )
        for r in pending
    ]


@router.patch("/sessions/{session_id}/requests/{request_id}")
async def resolve_request(
    session_id: str,
    request_id: str,
    body: ResolveRequestBody,
    uid: str = Depends(verify_token),
):
    session = session_store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.dj_uid != uid:
        raise HTTPException(status_code=403, detail="Not your session")

    req = session_store.resolve_request(session_id, request_id, body.status)
    if not req:
        raise HTTPException(status_code=404, detail="Request not found or already resolved")

    effective_track_id = body.track_id or req.track_id
    if body.status == "accepted" and effective_track_id:
        # Check if track is available before queueing
        queued = _insert_request_into_queue(uid, effective_track_id)
        
        if not queued:
            # Track not yet available — either metadata missing or audio file not on disk
            raise HTTPException(
                status_code=422,
                detail=f"Cannot queue '{effective_track_id}': Track metadata or audio file not available locally on the DJ's machine."
            )
        
        # Broadcast queue update
        await manager.broadcast_to_user(uid, {
            "type": "queue.updated",
            "tracks": app_state.queue_as_list(uid),
        })
        await session_store.audience_ws.broadcast(session_id, {
            "type": "queue.update",
            "queue": app_state.queue_as_list(uid),
        })

    # Notify audience about resolution
    await session_store.audience_ws.broadcast(session_id, {
        "type": "request.resolved",
        "request_id": request_id,
        "status": body.status,
    })

    # Notify DJ
    await manager.broadcast_to_user(uid, {
        "type": "request.resolved",
        "request_id": request_id,
        "status": body.status,
    })

    return {"request_id": request_id, "status": body.status}


def _insert_request_into_queue(uid: str, track_id: str) -> bool:
    """Insert a track into the queue at the end of the request zone.
    
    Returns True if successfully queued, False if track is not available yet.

    Queue layout after current_index:
        [request zone tracks] [dj zone tracks]

    Request tracks have source="request" on their QueueEntry.
    """
    from pathlib import Path
    
    # Check if track is available in registry before queueing
    t = app_state.track_registry.get(track_id)
    if t is None:
        # Track not yet loaded on backend - don't queue it yet
        logging.warning(f"[Queue] Track '{track_id}' not in registry. Reject queue until available.")
        return False

    # CRITICAL: Check that the audio file actually exists on disk.
    # BeatBot's architecture is client-side only — DJ reads audio from their local
    # file system via File System Access API. The backend doesn't serve audio.
    # If the audio file isn't in data/custom/audio/, the DJ can't play it.
    base_dir = Path(__file__).parent.parent.parent.parent  # project root
    audio_dir = base_dir / "data" / "custom" / "audio"
    audio_file = audio_dir / f"{track_id}.mp3"
    audio_file_wav = audio_dir / f"{track_id}.wav"
    
    if not audio_file.exists() and not audio_file_wav.exists():
        logging.warning(
            f"[Queue] Audio file for '{track_id}' not found on disk at {audio_dir}. "
            f"Reject queue (no audio file available locally)."
        )
        return False

    user_state = app_state.get_user_state(uid)
    if t is not None:
        entry_sec, exit_sec, _, _, _ = app_state.predict_cues(t)
    else:
        entry_sec, exit_sec = 0.0, 0.0

    from api.state import QueueEntry
    new_entry = QueueEntry(
        track_id=track_id,
        entry_sec=entry_sec,
        exit_sec=exit_sec,
        source="request",
    )

    # Find insertion point: after current_index, after all existing request entries
    ci = user_state.current_index
    insert_at = ci + 1
    for i in range(ci + 1, len(user_state.queue)):
        if getattr(user_state.queue[i], 'source', 'dj') == 'request':
            insert_at = i + 1
        else:
            break

    user_state.queue.insert(insert_at, new_entry)
    logging.info(f"[Queue] Audience request '{track_id}' added to queue at position {insert_at}")
    return True


# ── Public endpoints (no auth) ──────────────────────────────────────────────

@router.get("/sessions/{session_id}", response_model=SessionState)
def get_session_public(session_id: str):
    return _session_state_response(session_id)


@router.get("/sessions/{session_id}/library")
def search_session_library(session_id: str, q: str = Query("", min_length=0)):
    session = session_store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Search DJ's track registry
    results = []
    query_lower = q.lower()
    for tid, track in app_state.track_registry.items():
        if not q or query_lower in tid.lower():
            results.append(TrackMeta(
                track_id=track.track_id,
                duration=getattr(track, 'duration', 0.0) or 0.0,
                tempo=getattr(track, 'tempo', 0.0) or 0.0,
                key=getattr(track, 'key', None),
                camelot=getattr(track, 'camelot', None),
                num_bars=len(getattr(track, 'bars', [])),
                has_cue_labels=bool(getattr(track, 'cue_in', None) is not None),
                collection=getattr(track, 'collection', 'custom'),
            ))
    return results[:50]


@router.post("/sessions/{session_id}/requests", response_model=SongRequestResponse)
async def submit_request(session_id: str, body: SongRequestCreate):
    session = session_store.get_session(session_id)
    if not session or not session.active:
        raise HTTPException(status_code=404, detail="Session not found or ended")

    req = SongRequest(
        request_id=_nanoid(8),
        session_id=session_id,
        display_name=body.display_name,
        source=body.source,
        track_id=body.track_id,
        youtube_url=body.youtube_url,
        query=body.query,
    )
    session_store.add_request(session_id, req)

    # Notify DJ of new request
    await manager.broadcast_to_user(session.dj_uid, {
        "type": "request.new",
        "request_id": req.request_id,
        "display_name": req.display_name,
        "query": req.query,
        "source": req.source,
        "track_id": req.track_id,
        "youtube_url": req.youtube_url,
        "created_at": req.created_at,
    })

    return SongRequestResponse(
        request_id=req.request_id,
        session_id=req.session_id,
        display_name=req.display_name,
        source=req.source,
        track_id=req.track_id,
        youtube_url=req.youtube_url,
        query=req.query,
        status=req.status,
        created_at=req.created_at,
    )


# ── Audience WebSocket ───────────────────────────────────────────────────────

@router.websocket("/ws/live/{session_id}")
async def ws_audience(websocket: WebSocket, session_id: str, listener_id: str = ""):
    """Read-only WebSocket for audience members. No auth required."""
    session = session_store.get_session(session_id)
    if not session or not session.active:
        await websocket.close(code=4004)
        return

    await websocket.accept()

    if not listener_id:
        listener_id = _nanoid(8)

    session.record_listener(listener_id)

    # Update peak listeners
    count = session_store.audience_ws.listener_count(session_id) + 1
    if count > session.analytics.peak_listeners:
        session.analytics.peak_listeners = count

    await session_store.audience_ws.connect(websocket, session_id, listener_id)

    # Send initial state
    try:
        await websocket.send_json({
            "type": "session.state",
            "session_id": session.session_id,
            "active": session.active,
            "dj_connected": session.dj_connected,
            "current_track_id": session.current_track_id,
            "current_index": session.current_index,
            "elapsed_sec": session.elapsed_sec,
            "queue": _queue_items_for_session(session.dj_uid),
            "listener_count": count,
        })
    except Exception:
        session_store.audience_ws.disconnect(websocket, session_id)
        return

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            if msg_type == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.debug("Audience WS error: %s", exc)
    finally:
        session_store.audience_ws.disconnect(websocket, session_id)
