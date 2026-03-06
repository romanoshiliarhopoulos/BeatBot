"""
GET /tracks — return full library metadata.

Two modes
──────────
Cloud (Firestore):  reads users/{uid}/library, which the browser populates
                    after scanning a local folder and running extraction.
                    Any fields missing from Firestore documents are filled
                    with safe defaults so the response always validates.

Local dev (registry):  reads the in-memory track_registry as before.
                       Activated when the uid is the local-dev sentinel or
                       when Firestore returns an empty library.
"""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.auth import DEV_UID, verify_token
from api.firestore_client import (
    clear_library,
    delete_track,
    get_library,
    list_feature_track_ids,
    set_library_track,
)
from api.schemas import TrackMeta
from api.state import app_state

router = APIRouter()

_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _tracks_from_registry() -> List[TrackMeta]:
    """Build TrackMeta list from the local in-memory registry."""
    out: List[TrackMeta] = []
    for t in app_state.track_registry.values():
        key_name = None
        if t.key_tonic is not None and t.key_scale is not None:
            note = _NOTE_NAMES[t.key_tonic % 12]
            key_name = f"{note}{'m' if t.key_scale == 'minor' else ''}"
        collection = (
            "m-djcue"
            if t.source.upper().replace("_", "-") == "M-DJCUE"
            else "custom"
        )
        out.append(
            TrackMeta(
                track_id=t.track_id,
                duration=round(t.duration, 2),
                tempo=round(t.tempo, 1),
                key=key_name,
                camelot=t.camelot_code,
                num_bars=t.num_bars,
                has_cue_labels=t.has_cue_labels,
                collection=collection,
            )
        )
    return sorted(out, key=lambda x: x.track_id.lower())


def _tracks_from_firestore(uid: str) -> List[TrackMeta]:
    """
    Build TrackMeta list using *features* as the authoritative source of track
    IDs, merged with any library metadata that exists.

    Only tracks that have been uploaded via `beatbot extract` appear here.
    Stale library-only entries (e.g. from a previous import) are silently
    ignored because they have no corresponding features document.
    """
    feature_ids = list_feature_track_ids(uid)
    if not feature_ids:
        return []

    # Build a quick lookup from whatever library docs exist
    lib_docs = get_library(uid)
    lib_map  = {doc.get("track_id", ""): doc for doc in lib_docs}

    out: List[TrackMeta] = []
    for track_id in feature_ids:
        doc = lib_map.get(track_id, {})
        out.append(
            TrackMeta(
                track_id=track_id,
                duration=doc.get("duration", 0.0),
                tempo=doc.get("tempo", 0.0),
                key=doc.get("key"),
                camelot=doc.get("camelot"),
                num_bars=doc.get("num_bars", 0),
                has_cue_labels=doc.get("has_cue_labels", False),
                collection=doc.get("collection", "custom"),
            )
        )
    return sorted(out, key=lambda x: x.track_id.lower())


@router.get("/tracks", response_model=List[TrackMeta])
def get_tracks(uid: str = Depends(verify_token)):
    """
    Return metadata for every track in this user's library.

    - Cloud / real uid:  reads from Firestore; falls back to registry if empty.
    - Local dev uid:     reads directly from registry.
    """
    if uid != DEV_UID:
        fs_tracks = _tracks_from_firestore(uid)
        if fs_tracks:
            return fs_tracks
        # Firestore empty (first run or not yet extracted) — fall through

    return _tracks_from_registry()


@router.put("/tracks/{track_id}", status_code=204)
def upsert_track(
    track_id: str,
    body: TrackMeta,
    uid: str = Depends(verify_token),
):
    """
    Upsert a track stub into users/{uid}/library/{track_id} in Firestore.
    Called by the browser after local extraction to register a track's metadata.
    No-op in local dev (DEV_UID).
    """
    if uid == DEV_UID:
        return
    set_library_track(uid, track_id, body.model_dump())


@router.delete("/tracks/{track_id}", status_code=204)
def remove_track(
    track_id: str,
    uid: str = Depends(verify_token),
):
    """Delete a track from the user's Firestore library and feature store."""
    if uid == DEV_UID:
        raise HTTPException(status_code=403, detail="Cannot delete in local dev mode.")
    delete_track(uid, track_id)


class _PurgeBody(BaseModel):
    keep_track_ids: List[str]


@router.post("/tracks/purge", status_code=200)
def purge_tracks(
    body: _PurgeBody,
    uid: str = Depends(verify_token),
):
    """
    Delete every track in the user's library that is NOT in keep_track_ids.
    Intended for 'purge orphaned' — pass the set of track IDs currently present
    in the user's local music folder.
    Returns {deleted: N}.
    """
    if uid == DEV_UID:
        raise HTTPException(status_code=403, detail="Cannot purge in local dev mode.")
    keep = set(body.keep_track_ids)
    all_tracks = get_library(uid)
    deleted = 0
    for doc in all_tracks:
        tid = doc.get("track_id", "")
        if tid and tid not in keep:
            delete_track(uid, tid)
            deleted += 1
    return {"deleted": deleted}


@router.delete("/tracks", status_code=200)
def clear_all_tracks(
    uid: str = Depends(verify_token),
):
    """
    Delete every document in users/{uid}/library AND users/{uid}/features.
    Hard reset — use when you want to start fresh from CLI uploads.
    Returns {deleted: N}.
    """
    if uid == DEV_UID:
        raise HTTPException(status_code=403, detail="Cannot clear in local dev mode.")
    deleted = clear_library(uid)
    return {"deleted": deleted}


@router.get("/features", response_model=List[str])
def get_feature_ids(uid: str = Depends(verify_token)):
    """Return a list of track_ids for which CLI features have been uploaded."""
    if uid == DEV_UID:
        return list(app_state.track_registry.keys())
    return list_feature_track_ids(uid)
