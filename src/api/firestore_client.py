"""
Firestore helpers — library stubs and cue-prediction cache.

All functions are synchronous (firebase_admin uses the sync Firestore client).
Each function silently no-ops when firebase_admin is not installed, so the
server keeps working in local dev without a Firebase project.

Firestore schema
────────────────
users/{uid}/library/{track_id}   — track stub written by the browser after scanning
users/{uid}/cues/{track_id}      — full PredictResponse cached after first prediction
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

log = logging.getLogger("beatbot.firestore")

# ── Optional firebase_admin import ───────────────────────────────────────────

try:
    from firebase_admin import firestore as _fb_firestore
    _AVAILABLE = True
except ImportError:
    _AVAILABLE = False
    log.warning("firebase_admin not installed — Firestore read/write disabled.")


def _db():
    """Return the Firestore client (reuses the already-initialised Firebase app)."""
    return _fb_firestore.client()


# ── Library ──────────────────────────────────────────────────────────────────

def get_library(uid: str) -> List[Dict[str, Any]]:
    """Return all documents from users/{uid}/library."""
    if not _AVAILABLE:
        return []
    try:
        docs = _db().collection("users").document(uid).collection("library").stream()
        return [doc.to_dict() for doc in docs]
    except Exception as exc:
        log.error("Firestore get_library(%s) error: %s", uid, exc)
        return []


def set_library_track(uid: str, track_id: str, data: Dict[str, Any]) -> None:
    """Upsert a track stub document into users/{uid}/library/{track_id}."""
    if not _AVAILABLE:
        return
    try:
        (
            _db()
            .collection("users")
            .document(uid)
            .collection("library")
            .document(track_id)
            .set(data, merge=True)
        )
    except Exception as exc:
        log.error("Firestore set_library_track(%s, %s) error: %s", uid, track_id, exc)


# ── Feature store ─────────────────────────────────────────────────────────────
# Stores raw pkl bytes from the CLI so the API can re-run the model fresh on
# every request.  Predictions are never cached — only raw extracted features.
# This ensures that rolling out a new model (or new scoring weights) to Cloud
# Run automatically applies to every future /predict call for every user.
#
# Firestore schema:
#   users/{uid}/features/{track_id}  →  {"pkl": <bytes>, "updated_at": <ts>}

def set_features(uid: str, track_id: str, pkl_bytes: bytes) -> None:
    """Persist raw Track pkl bytes in users/{uid}/features/{track_id}."""
    if not _AVAILABLE:
        return
    try:
        from google.cloud.firestore_v1 import SERVER_TIMESTAMP  # type: ignore
        (
            _db()
            .collection("users")
            .document(uid)
            .collection("features")
            .document(track_id)
            .set({"pkl": pkl_bytes, "updated_at": SERVER_TIMESTAMP})
        )
    except Exception as exc:
        log.error("Firestore set_features(%s, %s) error: %s", uid, track_id, exc)


def get_features(uid: str, track_id: str) -> Optional[bytes]:
    """Retrieve raw Track pkl bytes from users/{uid}/features/{track_id}, or None."""
    if not _AVAILABLE:
        return None
    try:
        doc = (
            _db()
            .collection("users")
            .document(uid)
            .collection("features")
            .document(track_id)
            .get()
        )
        if doc.exists:
            return doc.to_dict().get("pkl")
        return None
    except Exception as exc:
        log.error("Firestore get_features(%s, %s) error: %s", uid, track_id, exc)
        return None


def list_feature_track_ids(uid: str) -> List[str]:
    """Return a list of track_ids that have features stored in users/{uid}/features."""
    if not _AVAILABLE:
        return []
    try:
        docs = _db().collection("users").document(uid).collection("features").stream()
        return [doc.id for doc in docs]
    except Exception as exc:
        log.error("Firestore list_feature_track_ids(%s) error: %s", uid, exc)
        return []


def delete_track(uid: str, track_id: str) -> None:
    """Delete a track from users/{uid}/library and users/{uid}/features (if present)."""
    if not _AVAILABLE:
        return
    user_ref = _db().collection("users").document(uid)
    for collection_name in ("library", "features"):
        try:
            user_ref.collection(collection_name).document(track_id).delete()
        except Exception as exc:
            log.error(
                "Firestore delete_track(%s, %s) [%s] error: %s",
                uid, track_id, collection_name, exc,
            )


def clear_library(uid: str) -> int:
    """
    Delete every document in users/{uid}/library and users/{uid}/features.
    Returns the total number of documents deleted.
    """
    if not _AVAILABLE:
        return 0
    user_ref = _db().collection("users").document(uid)
    deleted = 0
    for collection_name in ("library", "features"):
        try:
            col_ref = user_ref.collection(collection_name)
            while True:
                batch_docs = list(col_ref.limit(500).stream())
                if not batch_docs:
                    break
                batch = _db().batch()
                for doc in batch_docs:
                    batch.delete(doc.reference)
                batch.commit()
                deleted += len(batch_docs)
        except Exception as exc:
            log.error("Firestore clear_library(%s) [%s] error: %s", uid, collection_name, exc)
    return deleted
