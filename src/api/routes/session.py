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

                    # Broadcast playback tick to all clients for this user
                    await manager.broadcast_to_user(uid, {
                        "type":                   "playback.tick",
                        "track_id":               entry.track_id,
                        "elapsed_sec":            round(elapsed, 2),
                        "duration_sec":           round(duration, 2),
                        "progress":               round(progress, 4),
                        "next_transition_in_sec": round(transition_in, 2),
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
