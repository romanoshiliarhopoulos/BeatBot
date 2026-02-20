"""
WebSocket connection manager.

All server-side pushes go through WSManager.broadcast().
The manager silently drops dead connections so callers never need
to worry about disconnected clients.
"""
from __future__ import annotations

import logging
from typing import List

from fastapi import WebSocket

log = logging.getLogger("beatbot.ws")


class WSManager:
    def __init__(self) -> None:
        self._connections: List[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._connections.append(ws)
        log.info("WS client connected  (total=%d)", len(self._connections))

    def disconnect(self, ws: WebSocket) -> None:
        try:
            self._connections.remove(ws)
        except ValueError:
            pass
        log.info("WS client disconnected (total=%d)", len(self._connections))

    async def broadcast(self, data: dict) -> None:
        """Send a JSON payload to every connected client."""
        dead: List[WebSocket] = []
        for ws in list(self._connections):
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    async def send_to(self, ws: WebSocket, data: dict) -> None:
        """Send a JSON payload to one specific client."""
        try:
            await ws.send_json(data)
        except Exception:
            self.disconnect(ws)

    @property
    def connection_count(self) -> int:
        return len(self._connections)


# Singleton used throughout the app
manager = WSManager()
