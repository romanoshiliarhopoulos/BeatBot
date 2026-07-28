"""
Live session state — in-memory store that works with or without Firestore.

Each DJ can have at most one active session.  Sessions are identified by a
short nanoid-style ID.  All state lives in memory so local dev works out of
the box; Firestore persistence can be layered on later.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import string
import time
from dataclasses import dataclass, field
from typing import Dict, List, Literal, Optional

from fastapi import WebSocket

log = logging.getLogger("beatbot.session")

# ── ID generation ────────────────────────────────────────────────────────────

_ALPHABET = string.ascii_letters + string.digits
_ID_LEN = 6


def _nanoid(length: int = _ID_LEN) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


# ── Data models ──────────────────────────────────────────────────────────────

@dataclass
class SongRequest:
    request_id: str
    session_id: str
    display_name: str
    source: Literal["library", "youtube"]
    track_id: Optional[str] = None
    youtube_url: Optional[str] = None
    query: str = ""
    status: Literal["pending", "accepted", "denied"] = "pending"
    created_at: float = field(default_factory=time.time)


@dataclass
class SessionAnalytics:
    peak_listeners: int = 0
    unique_listeners: int = 0
    total_requests: int = 0
    accepted_requests: int = 0
    denied_requests: int = 0
    tracks_played: List[str] = field(default_factory=list)
    duration_sec: float = 0.0


@dataclass
class LiveSession:
    session_id: str
    dj_uid: str
    created_at: float = field(default_factory=time.time)
    ended_at: Optional[float] = None
    active: bool = True
    last_heartbeat_at: float = field(default_factory=time.time)
    dj_connected: bool = True

    # Snapshot of current playback (for audience + recovery)
    current_track_id: Optional[str] = None
    current_index: int = 0
    elapsed_sec: float = 0.0

    # Requests
    requests: Dict[str, SongRequest] = field(default_factory=dict)

    # Analytics
    analytics: SessionAnalytics = field(default_factory=SessionAnalytics)
    _listener_ids: set = field(default_factory=set)

    def record_listener(self, listener_id: str) -> None:
        self._listener_ids.add(listener_id)
        self.analytics.unique_listeners = len(self._listener_ids)


# ── Audience WebSocket pool ──────────────────────────────────────────────────

class AudienceWSManager:
    """Manages read-only WebSocket connections for audience members."""

    def __init__(self) -> None:
        # session_id -> list of (ws, listener_id)
        self._connections: Dict[str, List[tuple[WebSocket, str]]] = {}

    async def connect(self, ws: WebSocket, session_id: str, listener_id: str) -> None:
        if session_id not in self._connections:
            self._connections[session_id] = []
        self._connections[session_id].append((ws, listener_id))

    def disconnect(self, ws: WebSocket, session_id: str) -> None:
        if session_id not in self._connections:
            return
        self._connections[session_id] = [
            (w, lid) for w, lid in self._connections[session_id] if w is not ws
        ]
        if not self._connections[session_id]:
            del self._connections[session_id]

    def listener_count(self, session_id: str) -> int:
        return len(self._connections.get(session_id, []))

    async def broadcast(self, session_id: str, data: dict) -> None:
        if session_id not in self._connections:
            return
        dead: List[WebSocket] = []
        for ws, _ in list(self._connections[session_id]):
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws, session_id)


# ── Session store ────────────────────────────────────────────────────────────

HEARTBEAT_TIMEOUT_SEC = 5 * 60  # 5 minutes


class SessionStore:
    """In-memory session store.  One per process."""

    def __init__(self) -> None:
        self.sessions: Dict[str, LiveSession] = {}
        # dj_uid -> session_id for quick lookup of active session
        self._active_by_dj: Dict[str, str] = {}
        self.audience_ws = AudienceWSManager()
        self._timeout_task: Optional[asyncio.Task] = None

    # ── lifecycle ─────────────────────────────────────────────────────────

    def create_session(self, dj_uid: str) -> LiveSession:
        # End any existing active session for this DJ
        existing_id = self._active_by_dj.get(dj_uid)
        if existing_id and existing_id in self.sessions:
            self.end_session(existing_id)

        session_id = _nanoid()
        session = LiveSession(session_id=session_id, dj_uid=dj_uid)
        self.sessions[session_id] = session
        self._active_by_dj[dj_uid] = session_id
        log.info("Session %s created for DJ %s", session_id, dj_uid)
        return session

    def get_session(self, session_id: str) -> Optional[LiveSession]:
        return self.sessions.get(session_id)

    def get_active_session_for_dj(self, dj_uid: str) -> Optional[LiveSession]:
        sid = self._active_by_dj.get(dj_uid)
        if sid and sid in self.sessions and self.sessions[sid].active:
            return self.sessions[sid]
        return None

    def end_session(self, session_id: str) -> Optional[LiveSession]:
        session = self.sessions.get(session_id)
        if session and session.active:
            session.active = False
            session.ended_at = time.time()
            session.analytics.duration_sec = session.ended_at - session.created_at
            self._active_by_dj.pop(session.dj_uid, None)
            log.info("Session %s ended", session_id)
        return session

    def heartbeat(self, session_id: str) -> None:
        session = self.sessions.get(session_id)
        if session and session.active:
            session.last_heartbeat_at = time.time()
            session.dj_connected = True

    def get_history(self, dj_uid: str) -> List[LiveSession]:
        return [
            s for s in self.sessions.values()
            if s.dj_uid == dj_uid and not s.active
        ]

    # ── requests ──────────────────────────────────────────────────────────

    def add_request(self, session_id: str, req: SongRequest) -> None:
        session = self.sessions.get(session_id)
        if not session:
            return
        session.requests[req.request_id] = req
        session.analytics.total_requests += 1

    def resolve_request(
        self, session_id: str, request_id: str, status: Literal["accepted", "denied"]
    ) -> Optional[SongRequest]:
        session = self.sessions.get(session_id)
        if not session:
            return None
        req = session.requests.get(request_id)
        if not req or req.status != "pending":
            return None
        req.status = status
        if status == "accepted":
            session.analytics.accepted_requests += 1
        else:
            session.analytics.denied_requests += 1
        return req

    def get_pending_requests(self, session_id: str) -> List[SongRequest]:
        session = self.sessions.get(session_id)
        if not session:
            return []
        return [r for r in session.requests.values() if r.status == "pending"]

    # ── timeout checker ───────────────────────────────────────────────────

    async def _check_timeouts(self) -> None:
        """Periodically check for sessions that timed out."""
        while True:
            await asyncio.sleep(30)
            now = time.time()
            timed_out = []
            for sid, session in self.sessions.items():
                if session.active and (now - session.last_heartbeat_at) > HEARTBEAT_TIMEOUT_SEC:
                    timed_out.append(sid)

            for sid in timed_out:
                log.warning("Session %s timed out (no heartbeat for %ds)", sid, HEARTBEAT_TIMEOUT_SEC)
                self.end_session(sid)
                await self.audience_ws.broadcast(sid, {"type": "session.end"})

    def start_timeout_checker(self) -> None:
        if self._timeout_task is None or self._timeout_task.done():
            self._timeout_task = asyncio.create_task(self._check_timeouts())

    def stop_timeout_checker(self) -> None:
        if self._timeout_task and not self._timeout_task.done():
            self._timeout_task.cancel()


# ── Singleton ────────────────────────────────────────────────────────────────

session_store = SessionStore()
