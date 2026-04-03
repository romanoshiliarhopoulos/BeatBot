"""
Transition strategy selector.

Given normalised [0,1] feature arrays from the outgoing track (at exit bar)
and incoming track (at entry bar), selects the most appropriate transition
type and parameters.  The same logic lives in the frontend
(frontend/src/utils/transitionStrategy.ts) — keep both in sync.
"""
from __future__ import annotations

from typing import List, Optional


def compute_transition_config(
    *,
    out_energy: Optional[List[float]] = None,
    out_bass: Optional[List[float]] = None,
    out_vocal: Optional[List[float]] = None,
    out_beat_strength: Optional[List[float]] = None,
    out_exit_bar: int = 0,
    in_energy: Optional[List[float]] = None,
    in_bass: Optional[List[float]] = None,
    in_vocal: Optional[List[float]] = None,
    in_beat_strength: Optional[List[float]] = None,
    in_entry_bar: int = 0,
    out_tempo: float = 120.0,
    fade_secs: float = 7.0,
) -> dict:
    """Rule-based transition selector.  Returns a dict matching TransitionConfig."""

    out_e = _avg(out_energy, out_exit_bar)
    out_b = _avg(out_bass, out_exit_bar)
    out_v = _avg(out_vocal, out_exit_bar)
    out_bs = _avg(out_beat_strength, out_exit_bar)

    in_e = _avg(in_energy, in_entry_bar)
    in_b = _avg(in_bass, in_entry_bar)
    in_v = _avg(in_vocal, in_entry_bar)
    in_bs = _avg(in_beat_strength, in_entry_bar)

    in_e_ahead = _avg(in_energy, in_entry_bar + 8, window=8)
    beat_time = 60.0 / max(out_tempo, 60)

    # 1. EQ Bass Swap
    if out_b > 0.5 and in_b > 0.5 and out_bs > 0.4 and in_bs > 0.4:
        return dict(
            type="eq_swap", curve="equal_power",
            fade_secs=fade_secs, bass_swap_at=0.3,
        )

    # 3. Filter Sweep (vocals on outgoing)
    if out_v > 0.5:
        return dict(
            type="filter_sweep", curve="equal_power",
            fade_secs=fade_secs,
            filter_start_hz=20000.0, filter_end_hz=200.0,
        )

    # 4. Echo Out (rhythmic content)
    if out_bs > 0.6 and out_e > 0.5:
        return dict(
            type="echo_out", curve="equal_power",
            fade_secs=fade_secs,
            delay_time_sec=round(beat_time, 3), delay_feedback=0.5,
        )

    # 5. Harmonic Blend (both low energy)
    if out_e < 0.35 and in_e < 0.35 and out_v < 0.3 and in_v < 0.3:
        return dict(
            type="harmonic_blend", curve="equal_power",
            fade_secs=max(fade_secs, 10.0),
        )

    # 6. Default
    return dict(type="crossfade", curve="equal_power", fade_secs=fade_secs)


def _avg(arr: Optional[List[float]], center: int, window: int = 4) -> float:
    if not arr:
        return 0.0
    lo = max(0, center - window)
    hi = min(len(arr), center + window)
    vals = arr[lo:hi]
    return sum(vals) / len(vals) if vals else 0.0
