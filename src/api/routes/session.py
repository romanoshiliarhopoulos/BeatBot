"""
WebSocket endpoint — /ws/session

Handles:
  • server → client broadcasts (tick, track_changed, queue_updated, etc.)
  • client → server messages (position_sync, ping)
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException

from api.auth import verify_token
from api.state import app_state
from api.session_state import session_store
from api.ws_manager import manager

log = logging.getLogger("beatbot.ws.session")
router = APIRouter()


@router.websocket("/ws/session")
async def ws_session(websocket: WebSocket, token: str = ""):
    """
    Persistent WebSocket session.

    Messages from the client:

        { "type": "client.position", "elapsed_sec": 87.5 }
            Update the server's notion of playback position.
            The server re-broadcasts as playback.tick so other tabs stay in sync.

        { "type": "ping" }
            Keepalive.  Server replies { "type": "pong" }.
    """
    await websocket.accept()

    try:
        # Verify the token sent as a query parameter
        uid = verify_token(f"Bearer {token}") if token else verify_token("")
    except HTTPException:
        await websocket.close(code=1008)
        return

    # Now that we know who this is, connect them correctly
    await manager.connect(websocket, uid)
    
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "client.position":
                elapsed = float(data.get("elapsed_sec", 0.0))
                
                user_state = app_state.get_user_state(uid)
                user_state.playback.elapsed_sec = elapsed

                # Find current queue entry
                ci = user_state.current_index
                q  = user_state.queue
                if 0 <= ci < len(q):
                    entry = q[ci]
                    t = app_state.track_registry.get(entry.track_id)
                    duration = t.duration if t else 0.0
                    progress = min(elapsed / duration, 1.0) if duration > 0 else 0.0
                    transition_in = max(0.0, entry.exit_sec - elapsed)

                    tick_data = {
                        "type":                   "playback.tick",
                        "track_id":               entry.track_id,
                        "elapsed_sec":            round(elapsed, 2),
                        "duration_sec":           round(duration, 2),
                        "progress":               round(progress, 4),
                        "next_transition_in_sec": round(transition_in, 2),
                        "current_index":          ci,
                    }

                    # Broadcast playback tick to all clients for this user
                    await manager.broadcast_to_user(uid, tick_data)

                    # Also broadcast to audience if there's a live session
                    live = session_store.get_active_session_for_dj(uid)
                    if live:
                        live.elapsed_sec = round(elapsed, 2)
                        live.current_track_id = entry.track_id
                        live.current_index = ci
                        await session_store.audience_ws.broadcast(
                            live.session_id, tick_data
                        )

            elif msg_type == "session.heartbeat":
                # Forward heartbeat to session store
                live = session_store.get_active_session_for_dj(uid)
                if live:
                    session_store.heartbeat(live.session_id)
                    # Update session playback snapshot
                    user_state = app_state.get_user_state(uid)
                    live.current_index = user_state.current_index
                    live.elapsed_sec = user_state.playback.elapsed_sec
                    if 0 <= user_state.current_index < len(user_state.queue):
                        live.current_track_id = user_state.queue[user_state.current_index].track_id
                    # Broadcast listener count + dj status to audience
                    count = session_store.audience_ws.listener_count(live.session_id)
                    if count > live.analytics.peak_listeners:
                        live.analytics.peak_listeners = count
                    await session_store.audience_ws.broadcast(live.session_id, {
                        "type": "session.dj_status",
                        "connected": True,
                        "listener_count": count,
                    })

            elif msg_type == "queue.update":
                # DJ frontend is syncing queue + cursor state
                current_index = int(data.get("current_index", 0))
                user_state = app_state.get_user_state(uid)
                user_state.current_index = current_index

                live = session_store.get_active_session_for_dj(uid)
                if live:
                    live.current_index = current_index
                    if 0 <= current_index < len(user_state.queue):
                        live.current_track_id = user_state.queue[current_index].track_id
                    await session_store.audience_ws.broadcast(live.session_id, {
                        "type": "queue.update",
                        "queue": app_state.queue_as_list(uid),
                        "current_index": current_index,
                    })

            elif msg_type == "ping":
                await manager.send_to(websocket, {"type": "pong"})

            else:
                log.debug("Unknown WS message type: %s", msg_type)

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.error("WS session error: %s", exc)
    finally:
        manager.disconnect(websocket, uid)
