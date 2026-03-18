"""
WebSocket connection manager.

All server-side pushes go through WSManager.broadcast().
The manager silently drops dead connections so callers never need
to worry about disconnected clients.
"""
from __future__ import annotations

import logging
from typing import List, Dict

from fastapi import WebSocket

log = logging.getLogger("beatbot.ws")


class WSManager:
    def __init__(self) -> None:
        self._connections: Dict[str, List[WebSocket]] = {}

    async def connect(self, ws: WebSocket, uid: str) -> None:
        if uid not in self._connections:
            self._connections[uid] = []
        self._connections[uid].append(ws)
        log.info("WS client connected for uid=%s (total_for_uid=%d)", uid, len(self._connections[uid]))

    def disconnect(self, ws: WebSocket, uid: str) -> None:
        if uid in self._connections:
            try:
                self._connections[uid].remove(ws)
                log.info("WS client disconnected for uid=%s (total_for_uid=%d)", uid, len(self._connections[uid]))
                if not self._connections[uid]:
                    del self._connections[uid]
            except ValueError:
                pass

    async def broadcast_to_user(self, uid: str, data: dict) -> None:
        """Send a JSON payload to every connected client for a given user."""
        if uid not in self._connections:
            return
            
        dead: List[WebSocket] = []
        for ws in list(self._connections[uid]):
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws, uid)

    async def send_to(self, ws: WebSocket, uid: str, data: dict) -> None:
        """Send a JSON payload to one specific client."""
        try:
            await ws.send_json(data)
        except Exception:
            self.disconnect(ws, uid)

    @property
    def connection_count(self) -> int:
        return sum(len(conns) for conns in self._connections.values())


# Singleton used throughout the app
manager = WSManager()
