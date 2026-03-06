"""
Firebase ID-token verification — FastAPI Dependency.

Usage:
    from api.auth import verify_token
    @router.get("/something")
    def handler(uid: str = Depends(verify_token)):
        ...

Local dev: set SKIP_AUTH=true in your environment (or .env) and every
request will be accepted with uid="local-dev-user", no Firebase needed.

Cloud Run: Application Default Credentials are picked up automatically;
no extra configuration required.
"""
from __future__ import annotations

import logging
import os

from fastapi import Header, HTTPException

log = logging.getLogger("beatbot.auth")

# ── Optional firebase_admin import ───────────────────────────────────────────

try:
    import firebase_admin
    from firebase_admin import auth as _fb_auth
    _FIREBASE_AVAILABLE = True
except ImportError:
    _FIREBASE_AVAILABLE = False

_initialized = False


def _ensure_app() -> None:
    """Initialize the Firebase Admin SDK once, reusing any existing app."""
    global _initialized
    if _initialized:
        return
    try:
        firebase_admin.get_app()
    except ValueError:
        # No app yet — initialize with Application Default Credentials.
        firebase_admin.initialize_app()
    _initialized = True


# ── Config ────────────────────────────────────────────────────────────────────

# Set SKIP_AUTH=true for local dev (avoids needing a service-account key).
_SKIP_AUTH = os.getenv("SKIP_AUTH", "false").lower() in ("true", "1", "yes")
DEV_UID    = "local-dev-user"


# ── Dependency ────────────────────────────────────────────────────────────────

def verify_token(authorization: str = Header(default="")) -> str:
    """
    FastAPI dependency that validates a Firebase Bearer token and returns uid.

    With SKIP_AUTH=true: always returns DEV_UID without contacting Firebase.
    In production (Cloud Run): verifies the token via firebase_admin.
    """
    if _SKIP_AUTH:
        return DEV_UID

    if not _FIREBASE_AVAILABLE:
        log.error("firebase_admin not installed but SKIP_AUTH is not set.")
        raise HTTPException(
            status_code=500,
            detail="Server auth not configured (firebase_admin missing).",
        )

    _ensure_app()

    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Authorization header.")

    token = authorization.removeprefix("Bearer ").strip()
    try:
        decoded = _fb_auth.verify_id_token(token)
        return decoded["uid"]
    except Exception as exc:
        log.warning("Token verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid or expired token.")
