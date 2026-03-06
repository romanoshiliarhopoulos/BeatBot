"""
AppState — shared server-side state for the BeatBot API.

Holds:
  • track_registry  – all processed tracks keyed by track_id
  • model           – loaded BeatBotModel (or None)
  • queue           – ordered list of QueueEntry dicts
  • current_index   – which queue slot is "now playing"
  • playback        – lightweight struct tracking elapsed_sec / playing flag

Everything is in-memory.  Cue point overrides are persisted back to .pkl files
so they survive restarts.
"""
from __future__ import annotations

import logging
import pickle
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

# ── project-root path resolution ─────────────────────────────────────────────
_API_DIR  = Path(__file__).parent            # src/api/
_SRC_DIR  = _API_DIR.parent                  # src/
_BASE_DIR = _SRC_DIR.parent                  # project root

if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from track import Track  # noqa: E402

AUDIO_DIR = _BASE_DIR / "data" / "custom" / "audio"
DATA_DIR  = _BASE_DIR / "data" / "processed"

log = logging.getLogger("beatbot.state")


# ── tiny helper ───────────────────────────────────────────────────────────────

def _fmt(s: float) -> str:
    return f"{int(s // 60):02d}:{int(s % 60):02d}"


# ── Playback state ────────────────────────────────────────────────────────────

@dataclass
class PlaybackState:
    playing: bool = False
    elapsed_sec: float = 0.0


# ── Queue entry ───────────────────────────────────────────────────────────────

@dataclass
class QueueEntry:
    track_id: str
    entry_sec: float
    exit_sec: float


# ── AppState ─────────────────────────────────────────────────────────────────

class AppState:
    def __init__(self) -> None:
        self.track_registry: Dict[str, Track] = {}
        self.model = None                    # BeatBotModel | None
        self.model_version: Optional[str] = None   # e.g. "run_20260218_231046"
        self.queue: List[QueueEntry] = []
        self.current_index: int = 0
        self.playback: PlaybackState = PlaybackState()

    # ── boot ─────────────────────────────────────────────────────────────────

    def load_tracks(self) -> int:
        """Scan DATA_DIR for .pkl files and populate track_registry."""
        audio_index: Dict[str, Path] = {}
        for p in AUDIO_DIR.glob("*.mp3"):
            audio_index[p.stem] = p
        for p in AUDIO_DIR.glob("*.wav"):
            audio_index[p.stem] = p

        count = 0
        for pkl in sorted(DATA_DIR.glob("*.pkl")):
            try:
                with open(pkl, "rb") as f:
                    t: Track = pickle.load(f)
            except Exception as exc:
                log.warning("Could not load %s: %s", pkl.name, exc)
                continue

            # Resolve audio path
            stem = Path(t.audio_path).stem if t.audio_path else None
            match = audio_index.get(stem) or audio_index.get(t.track_id)
            if match:
                t.audio_path = match
            self.track_registry[t.track_id] = t
            count += 1

        log.info("Loaded %d tracks into registry.", count)
        return count

    def load_model(self) -> bool:
        """Find the latest model run and load it. Returns True on success."""
        models_root = _BASE_DIR / "data" / "models"
        if not models_root.exists():
            log.warning("No models directory found at %s.", models_root)
            return False

        runs = sorted(models_root.glob("run_*"))
        if not runs:
            log.warning("No model runs found in %s.", models_root)
            return False

        latest = runs[-1]
        pkl = latest / "beatbot_model.pkl"
        if not pkl.exists():
            log.warning("No beatbot_model.pkl in %s.", latest)
            return False

        try:
            from model.lightgbm import BeatBotModel  # noqa: E402
            m = BeatBotModel(models_dir=str(latest))
            m.load("beatbot_model.pkl")
            self.model = m
            self.model_version = latest.name   # e.g. "run_20260218_231046"
            log.info("Model loaded from %s.", latest.name)
            return True
        except Exception as exc:
            log.error("Model load failed: %s", exc)
            return False

    # ── cue prediction ────────────────────────────────────────────────────────

    def predict_cues(
        self,
        track: Track,
        weights: Optional[Dict[str, float]] = None,
    ) -> Tuple[float, float, str, List[float], List[float]]:
        """
        Returns (entry_sec, exit_sec, method, score_in_list, score_out_list).
        method is "model" or "heuristic".
        score_in / score_out are normalised [0,1] per-bar lists.

        weights (optional): per-feature multipliers for future model tuning,
            e.g. {"energy": 1.5, "bass": 0.8}.  Currently reserved and not
            applied to the scoring logic.
        """
        bars = track.bars
        n    = len(bars)

        def _norm(v: np.ndarray) -> List[float]:
            lo, hi = float(v.min()), float(v.max())
            rng = hi - lo
            if rng < 1e-9:
                return [0.0] * len(v)
            return ((v - lo) / rng).tolist()

        if self.model is not None:
            try:
                df    = self.model.predict_track(track)
                s_in  = df["score_in"].values
                s_out = df["score_out"].values

                # Entry: use the model's top-ranked candidate as-is.
                result      = self.model.predict_cue_points(track, top_k=1, min_dist_bars=8)
                cue_in_list = result.get("cue_in", [])
                eb = cue_in_list[0]["bar_index"] if cue_in_list else 0
                eb = min(eb, n - 1)

                # Exit: apply a soft positional cap so the model cannot default
                # to the very end of the track.  The weight ramps from 1.0 at
                # 72 % of bars down to 0.0 at 88 %, killing any bar beyond that.
                # This keeps exits in a musically sensible 60-88 % window while
                # still following the shape of the learned score curve.
                positions  = np.arange(n) / max(n - 1, 1)   # 0 … 1 per bar
                pos_weight = np.clip(
                    1.0 - (positions - 0.72) / 0.16,
                    0.0, 1.0,
                )
                s_out_weighted = s_out * pos_weight
                xb = int(np.argmax(s_out_weighted))
                xb = min(xb, n - 1)

                entry_sec = float(bars[eb])
                exit_sec  = float(bars[xb])

                # Sanity-check: reject degenerate predictions.
                # Also guard against exit past 92 % just in case.
                track_start = float(bars[0])
                track_end   = float(bars[-1])
                time_range  = max(track_end - track_start, 1.0)
                min_sep     = min(90.0, time_range * 0.4)

                if (
                    entry_sec < track_start + time_range * 0.5
                    and (exit_sec - entry_sec) >= min_sep
                    and exit_sec <= track_start + time_range * 0.92
                ):
                    return entry_sec, exit_sec, "model", _norm(s_in), _norm(s_out)

                # Model cues are too close together or otherwise degenerate.
                # Rather than falling back to heuristic, force a valid exit:
                # mask out everything within min_sep of the chosen entry bar,
                # then pick the best remaining bar in the position window.
                log.warning(
                    "[%s] Model cues too close (entry=%s exit=%s); forcing valid exit.",
                    track.track_id, _fmt(entry_sec), _fmt(exit_sec),
                )
                mask = s_out_weighted.copy()
                # How many bars correspond to min_sep seconds?
                bar_dur = time_range / max(n - 1, 1)
                min_sep_bars = int(np.ceil(min_sep / bar_dur))
                mask[: eb + min_sep_bars] = -np.inf   # block entry region
                if np.all(~np.isfinite(mask)) or mask.max() <= 0:
                    # Nothing usable in the window — pick 75 % position
                    xb = int(n * 0.75)
                else:
                    xb = int(np.argmax(mask))
                xb = min(xb, n - 1)
                exit_sec = float(bars[xb])
                return entry_sec, exit_sec, "model", _norm(s_in), _norm(s_out)

            except Exception as exc:
                log.warning("[%s] Model prediction failed: %s", track.track_id, exc)

        # ── Time-based heuristic ───────────────────────────────────────────
        if n < 2:
            dur = getattr(track, "duration", None) or 180.0
            flat = [0.0] * max(n, 1)
            return dur * 0.10, dur * 0.80, "heuristic", flat, flat

        track_start = float(bars[0])
        track_end   = float(bars[-1])
        time_range  = max(track_end - track_start, 1.0)

        entry_target = track_start + time_range * 0.12
        exit_target  = track_start + time_range * 0.82

        eb = int(np.argmin(np.abs(bars - entry_target)))
        xb = int(np.argmin(np.abs(bars - exit_target)))

        min_sep_secs = min(90.0, time_range * 0.5)
        while float(bars[xb]) - float(bars[eb]) < min_sep_secs and xb < n - 1:
            xb += 1

        flat = [0.0] * n
        return float(bars[eb]), float(bars[xb]), "heuristic", flat, flat

    # ── queue helpers ─────────────────────────────────────────────────────────

    def add_tracks(self, track_ids: List[str]) -> List[str]:
        """
        Add tracks to queue.  Unknown track IDs (locally-extracted browser tracks
        not yet in the registry) are added with placeholder cues (0, 0) so the
        browser can update them after extraction.
        """
        for tid in track_ids:
            t = self.track_registry.get(tid)
            if t is not None:
                entry_sec, exit_sec, _, _, _ = self.predict_cues(t)
            else:
                entry_sec, exit_sec = 0.0, 0.0
            self.queue.append(QueueEntry(track_id=tid, entry_sec=entry_sec, exit_sec=exit_sec))
        return []

    def queue_as_list(self) -> List[dict]:
        return [
            {"position": i, "track_id": e.track_id,
             "entry_sec": e.entry_sec, "exit_sec": e.exit_sec}
            for i, e in enumerate(self.queue)
        ]

    # ── cue override persistence ──────────────────────────────────────────────

    def apply_cue_override(
        self,
        track_id: str,
        cue_type: str,          # "entry" | "exit"
        timestamp_sec: float,
    ) -> Tuple[float, int]:
        """
        Snap timestamp to nearest bar, persist to .pkl, update queue.
        Returns (accepted_sec, bar_index).
        """
        t = self.track_registry.get(track_id)
        if t is None:
            raise KeyError(f"Track '{track_id}' not in registry.")

        bar_index = int(np.argmin(np.abs(t.bars - timestamp_sec)))
        accepted  = float(t.bars[bar_index])

        # Persist label back into the Track object and re-pickle
        if cue_type == "entry":
            t.cue_in = np.array([accepted])
        else:
            t.cue_out = np.array([accepted])

        # Find .pkl on disk (stem match)
        stem = track_id
        pkl_path = DATA_DIR / f"{stem}.pkl"
        if pkl_path.exists():
            with open(pkl_path, "wb") as f:
                pickle.dump(t, f)

        # Update queue cue if this track is queued
        for entry in self.queue:
            if entry.track_id == track_id:
                if cue_type == "entry":
                    entry.entry_sec = accepted
                else:
                    entry.exit_sec = accepted

        return accepted, bar_index


# ── module-level singleton ────────────────────────────────────────────────────
app_state = AppState()
