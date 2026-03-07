"""
Mixes CRUD — per-user DJ mix lists stored in Firestore.

Endpoints:
  GET    /mixes              — list all mixes for the authenticated user
  POST   /mixes              — create (or upsert) a mix
  PUT    /mixes/{mix_id}     — update name / color / trackIds
  DELETE /mixes/{mix_id}     — delete a mix

Firestore path: users/{uid}/mixes/{mix_id}

The client generates UUIDs, so POST is effectively an upsert (set not add).
This keeps the frontend interface synchronous — it can navigate to the new mix
immediately without waiting for an API round-trip.
"""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.auth import verify_token
from api.firestore_client import delete_mix, get_mixes, set_mix

router = APIRouter(prefix="/mixes", tags=["mixes"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class MixOut(BaseModel):
    id: str
    name: str
    color: Optional[str] = None
    trackIds: List[str] = []
    createdAt: int = 0


class CreateMixBody(BaseModel):
    id: str                               # client-generated UUID
    name: str
    color: Optional[str] = None
    trackIds: List[str] = []
    createdAt: int = 0


class UpdateMixBody(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    trackIds: Optional[List[str]] = None


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("", response_model=List[MixOut])
def list_mixes(uid: str = Depends(verify_token)):
    """Return all mixes for the authenticated user, ordered by createdAt."""
    return get_mixes(uid)


@router.post("", response_model=MixOut, status_code=201)
def create_mix(body: CreateMixBody, uid: str = Depends(verify_token)):
    """Create (or replace) a mix document. The client supplies the UUID."""
    doc = body.model_dump()
    set_mix(uid, body.id, doc)
    return doc


@router.put("/{mix_id}", response_model=MixOut)
def update_mix(
    mix_id: str,
    body: UpdateMixBody,
    uid: str = Depends(verify_token),
):
    """Partial update — only supplied fields are written."""
    mixes = get_mixes(uid)
    existing = next((m for m in mixes if m["id"] == mix_id), None)
    if existing is None:
        raise HTTPException(status_code=404, detail="Mix not found")

    updates = body.model_dump(exclude_none=True)
    merged = {**existing, **updates}
    set_mix(uid, mix_id, merged)
    return merged


@router.delete("/{mix_id}", status_code=204)
def remove_mix(mix_id: str, uid: str = Depends(verify_token)):
    """Delete a mix document."""
    delete_mix(uid, mix_id)
