"""
Pydantic schemas for all BeatBot API request / response bodies.
"""
from __future__ import annotations

from typing import List, Literal, Optional, Union
from pydantic import BaseModel, Field


# ── Track metadata ─────────────────────────────────────────────────────────────

class TrackMeta(BaseModel):
    track_id: str
    duration: float
    tempo: float
    key: Optional[str] = None           # e.g. "Am"
    camelot: Optional[str] = None       # e.g. "8A"
    num_bars: int
    has_cue_labels: bool
    collection: Literal["custom", "m-djcue"] = "custom"


# ── Predict ────────────────────────────────────────────────────────────────────

class PredictResponse(BaseModel):
    track_id: str
    num_bars: int
    bar_times: List[float]              # seconds per bar index
    score_in: List[float]               # normalised [0,1] entry scores
    score_out: List[float]              # normalised [0,1] exit scores
    entry_sec: float
    exit_sec: float
    method: Literal["model", "heuristic"]
    # Model version tag — bumped each time a new model is deployed to Cloud Run.
    # Clients can use this to tell users their cue points used a specific model.
    model_version: Optional[str] = None
    # Optional per-bar feature arrays (all normalised to [0, 1])
    energy: Optional[List[float]] = None          # overall RMS energy
    bass_energy: Optional[List[float]] = None     # low-band (<250 Hz) energy
    high_energy: Optional[List[float]] = None     # high-band (>4 kHz) energy
    mid_energy: Optional[List[float]] = None      # mid-band (250-4 kHz) energy
    beat_strength: Optional[List[float]] = None   # onset strength per bar
    vocal_presence: Optional[List[float]] = None  # vocal activity [0,1]


# ── Cue editing ────────────────────────────────────────────────────────────────

class CueEditRequest(BaseModel):
    cue_type: Literal["entry", "exit"]
    timestamp_sec: float
    source: Literal["user_drag", "user_input"] = "user_drag"


class CueEditResponse(BaseModel):
    track_id: str
    cue_type: str
    accepted_sec: float                 # snapped to nearest bar
    bar_index: int


# ── Queue ──────────────────────────────────────────────────────────────────────

class QueueItem(BaseModel):
    position: int
    track_id: str
    entry_sec: float
    exit_sec: float


class QueueState(BaseModel):
    current_index: int
    tracks: List[QueueItem]


class AddToQueueRequest(BaseModel):
    track_ids: List[str] = Field(..., min_length=1)


class ReorderRequest(BaseModel):
    from_position: int
    to_position: int


# ── Transition ────────────────────────────────────────────────────────────────

class TransitionConfig(BaseModel):
    """Describes *how* a transition should be executed."""
    type: Literal[
        "crossfade", "eq_swap", "filter_sweep",
        "echo_out", "harmonic_blend",
    ] = "crossfade"
    curve: Literal["equal_power", "linear", "s_curve"] = "equal_power"
    fade_secs: float = 7.0
    bass_swap_at: Optional[float] = None
    filter_start_hz: Optional[float] = None
    filter_end_hz: Optional[float] = None
    delay_time_sec: Optional[float] = None
    delay_feedback: Optional[float] = None
    silence_sec: Optional[float] = None


class TransitionSuggestRequest(BaseModel):
    """Sent by the frontend when both decks are loaded to get the backend's
    recommended transition type."""
    out_track_id: str
    in_track_id: str
    out_exit_sec: float
    in_entry_sec: float
    fade_secs: float = 7.0


class EarlyTransitionRequest(BaseModel):
    fade_secs: float = 7.0


class EarlyTransitionResponse(BaseModel):
    next_track_id: str
    entry_sec: float
    exit_sec: float
    fade_secs: float
    transition: Optional[TransitionConfig] = None


# ── Playback (sent by browser over WebSocket) ─────────────────────────────────

class ClientPositionMessage(BaseModel):
    """Sent periodically by the frontend to sync server-side playback state."""
    type: Literal["client.position"]
    elapsed_sec: float


# ── WebSocket server-push event shapes ────────────────────────────────────────

class WsPlaybackTick(BaseModel):
    type: Literal["playback.tick"] = "playback.tick"
    track_id: str
    elapsed_sec: float
    duration_sec: float
    progress: float                     # 0.0 – 1.0
    next_transition_in_sec: float       # exit_sec - elapsed_sec


class WsTrackChanged(BaseModel):
    type: Literal["playback.track_changed"] = "playback.track_changed"
    prev_track_id: Optional[str]
    curr_track_id: str
    curr_entry_sec: float
    curr_exit_sec: float
    queue_position: int


class WsQueueUpdated(BaseModel):
    type: Literal["queue.updated"] = "queue.updated"
    tracks: List[QueueItem]


class WsCuesAccepted(BaseModel):
    type: Literal["cues.accepted"] = "cues.accepted"
    track_id: str
    cue_type: str
    accepted_sec: float
    bar_index: int


class WsModelWarning(BaseModel):
    type: Literal["model.warning"] = "model.warning"
    track_id: str
    message: str
    entry_sec: float
    exit_sec: float


class WsError(BaseModel):
    type: Literal["error"] = "error"
    code: str
    message: str
    recoverable: bool = True
