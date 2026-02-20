"""
WebSocket endpoint — /ws/session

Handles:
  • server → client broadcasts (tick, track_changed, queue_updated, etc.)
  • client → server messages (position_sync, ping)
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from api.state import app_state
from api.ws_manager import manager

log = logging.getLogger("beatbot.ws.session")
router = APIRouter()


@router.websocket("/ws/session")
async def ws_session(websocket: WebSocket):
    """
    Persistent WebSocket session.

    Messages from the client:

        { "type": "client.position", "elapsed_sec": 87.5 }
            Update the server's notion of playback position.
            The server re-broadcasts as playback.tick so other tabs stay in sync.

        { "type": "ping" }
            Keepalive.  Server replies { "type": "pong" }.
    """
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "client.position":
                elapsed = float(data.get("elapsed_sec", 0.0))
                app_state.playback.elapsed_sec = elapsed

                # Find current queue entry
                ci = app_state.current_index
                q  = app_state.queue
                if 0 <= ci < len(q):
                    entry = q[ci]
                    t = app_state.track_registry.get(entry.track_id)
                    duration = t.duration if t else 0.0
                    progress = min(elapsed / duration, 1.0) if duration > 0 else 0.0
                    transition_in = max(0.0, entry.exit_sec - elapsed)

                    # Broadcast playback tick to all clients
                    await manager.broadcast({
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
        manager.disconnect(websocket)
