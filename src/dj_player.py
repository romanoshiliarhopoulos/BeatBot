"""
BeatBot DJ Player — CLI
========================
Loads a random queue of your custom house music tracks, uses the trained
BeatBot model to pick the best entry/exit cue points, and plays them back
with smooth 7-second linear crossfades between tracks.

Usage:
    python src/dj_player.py                      # full random queue
    python src/dj_player.py --queue 5            # 5 random songs
    python src/dj_player.py --no-model           # heuristic cues only
    python src/dj_player.py --fade 10            # 10-second crossfade
"""

import sys
import pickle
import random
import time
import argparse
import threading
from pathlib import Path

import numpy as np
import soundfile as sf
import sounddevice as sd
import matplotlib
matplotlib.use("Agg")          # headless backend – we save PNGs instead of GUI windows
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec

# ── Path setup ────────────────────────────────────────────────────────────────
BASE_DIR   = Path(__file__).parent.parent
SRC_DIR    = Path(__file__).parent
AUDIO_DIR  = BASE_DIR / "data" / "custom" / "audio"
DATA_DIR   = BASE_DIR / "data" / "processed"
MODEL_DIR  = BASE_DIR / "data/models/run_20260218_231046"
MODEL_FILE = MODEL_DIR / "beatbot_model.pkl"

sys.path.insert(0, str(SRC_DIR))

from track import Track

# ── ANSI colours ──────────────────────────────────────────────────────────────
GRN  = "\033[92m"
RED  = "\033[91m"
YLW  = "\033[93m"
CYN  = "\033[96m"
DIM  = "\033[2m"
BOLD = "\033[1m"
RST  = "\033[0m"

TARGET_SR = 44100   # playback sample rate
CHANNELS  = 2       # stereo output


# ── Helpers ───────────────────────────────────────────────────────────────────

def fmt_time(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    return f"{m:02d}:{s:02d}"


def load_tracks_with_audio() -> list[Track]:
    """
    Return all processed tracks that have a matching audio file in AUDIO_DIR.
    The stored audio_path can be unreliable (relative to extraction cwd), so we
    do a direct filename lookup in the known audio directory instead.
    """
    # Build a fast lookup: stem -> full path  (case-insensitive fallback)
    audio_files = {p.stem: p for p in AUDIO_DIR.glob("*.mp3")}
    audio_files.update({p.stem: p for p in AUDIO_DIR.glob("*.wav")})

    tracks = []
    for pkl in sorted(DATA_DIR.glob("*.pkl")):
        try:
            with open(pkl, "rb") as f:
                t: Track = pickle.load(f)
        except Exception:
            continue

        # 1. Try matching by stored filename stem
        stored_stem = None
        if t.audio_path:
            stored_stem = Path(t.audio_path).stem
        match = audio_files.get(stored_stem) or audio_files.get(t.track_id)

        if match is not None:
            t.audio_path = match  # absolute Path
            tracks.append(t)

    return tracks


def load_audio(path: Path) -> tuple[np.ndarray, int]:
    """
    Load an audio file and return (stereo_float32_array, sample_rate).
    Resamples to TARGET_SR if needed; converts mono to stereo.
    """
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)

    # Resample via librosa if needed (rare for MP3s at 44100)
    if sr != TARGET_SR:
        import librosa
        data = librosa.resample(data.T, orig_sr=sr, target_sr=TARGET_SR).T
        sr = TARGET_SR

    # Ensure stereo
    if data.shape[1] == 1:
        data = np.tile(data, (1, 2))
    elif data.shape[1] > 2:
        data = data[:, :2]

    return data, sr


def predict_cues(track: Track, model) -> tuple[float, float]:
    """
    Return (entry_sec, exit_sec) timestamps using the BeatBot model.
    Falls back to a simple bar-position heuristic if model is None.
    """
    if model is not None:
        try:
            result = model.predict_cue_points(track, top_k=1, min_dist_bars=8)
            cue_in_list  = result.get("cue_in", [])
            cue_out_list = result.get("cue_out", [])

            entry_bar = cue_in_list[0]["bar_index"]  if cue_in_list  else 0
            exit_bar  = cue_out_list[0]["bar_index"] if cue_out_list else max(0, track.num_bars - 16)

            entry_sec = float(track.bars[min(entry_bar, track.num_bars - 1)])
            exit_sec  = float(track.bars[min(exit_bar,  track.num_bars - 1)])

            # Sanity-check the model output: reject if entry ≈ exit or
            # entry is in the last half of the track (degenerate model output).
            track_end = float(track.bars[-1]) if len(track.bars) else 0.0
            track_start = float(track.bars[0]) if len(track.bars) else 0.0
            time_range = max(track_end - track_start, 1.0)
            min_sep = min(90.0, time_range * 0.4)
            entry_ok = entry_sec < track_start + time_range * 0.5
            sep_ok   = (exit_sec - entry_sec) >= min_sep
            if entry_ok and sep_ok:
                return entry_sec, exit_sec
            print(f"  {YLW}[warn]{RST} Model cues look degenerate "
                  f"(entry={fmt_time(entry_sec)} exit={fmt_time(exit_sec)}), using heuristic.")
        except Exception as e:
            print(f"  {YLW}[warn]{RST} Model prediction failed ({e}), using heuristic.")

    # Time-based heuristic — robust to bars not starting at 0 and to tracks
    # with very few detected bars.
    bars = track.bars
    if len(bars) < 2:
        # Fallback: use raw duration if bars are basically absent
        dur = getattr(track, "duration", None) or (len(bars) and float(bars[-1])) or 180.0
        return dur * 0.10, dur * 0.80

    track_start = float(bars[0])
    track_end   = float(bars[-1])
    time_range  = max(track_end - track_start, 1.0)

    # Entry: first bar that falls inside [10%, 20%) of the actual bar time range
    entry_target = track_start + time_range * 0.12
    # Exit:  last bar that falls before 82% of the actual bar time range
    exit_target  = track_start + time_range * 0.82

    entry_bar = int(np.argmin(np.abs(bars - entry_target)))
    exit_bar  = int(np.argmin(np.abs(bars - exit_target)))

    # Enforce a minimum separation of ~90 s (or the full range if the track is short)
    min_sep_secs = min(90.0, time_range * 0.5)
    while float(bars[exit_bar]) - float(bars[entry_bar]) < min_sep_secs and exit_bar < len(bars) - 1:
        exit_bar += 1

    entry_sec = float(bars[entry_bar])
    exit_sec  = float(bars[exit_bar])
    return entry_sec, exit_sec


def plot_cue_scores(
    track_a, track_b, model,
    entry_a: float, exit_a: float,
    entry_b: float, exit_b: float,
    save_dir: Path = Path("/tmp"),
) -> Path:
    """
    Generates a 2-panel figure showing LambdaRank entry/exit scores (or a flat
    position line if no model) for track_a and track_b, with the selected cue
    markers overlaid.  Saves to a PNG and opens it in the default image viewer.
    Returns the path to the saved PNG.
    """
    fig = plt.figure(figsize=(14, 8))
    gs  = gridspec.GridSpec(2, 1, hspace=0.45)

    def _to_min_sec(s: float) -> str:
        return f"{int(s//60):d}:{int(s%60):02d}"

    def _draw_track(ax, track, entry_sec: float, exit_sec: float, role: str):
        bars = track.bars
        n    = len(bars)
        xs   = np.arange(n)
        times = bars  # seconds per bar index

        # x-tick labels: every ~10 bars, show MM:SS
        tick_step = max(1, n // 12)
        tick_pos  = xs[::tick_step]
        tick_lbls = [_to_min_sec(float(times[i])) for i in tick_pos]

        if model is not None:
            try:
                df  = model.predict_track(track)
                s_in  = df["score_in"].values
                s_out = df["score_out"].values
                # normalise to [0, 1] for readability
                def norm(v):
                    lo, hi = v.min(), v.max()
                    return (v - lo) / (hi - lo + 1e-9)
                s_in_n  = norm(s_in)
                s_out_n = norm(s_out)
                ax.plot(xs, s_in_n,  color="#2ecc71", lw=1.5, alpha=0.75, label="Entry score")
                ax.plot(xs, s_out_n, color="#e74c3c", lw=1.5, alpha=0.75, label="Exit score")
                y_entry = float(norm(s_in) [np.argmin(np.abs(times - entry_sec))])
                y_exit  = float(norm(s_out)[np.argmin(np.abs(times - exit_sec))])
            except Exception:
                ax.plot(xs, np.zeros(n), color="grey", lw=1, alpha=0.3)
                y_entry = y_exit = 0.0
        else:
            # No model — just show a flat line so cue markers still make sense
            ax.fill_between(xs, 0, 0.15, color="#95a5a6", alpha=0.2, label="No model (heuristic)")
            ax.set_ylim(-0.05, 1.05)
            y_entry = y_exit = 0.07

        # Vertical lines + star markers for selected cues
        entry_bar = int(np.argmin(np.abs(times - entry_sec)))
        exit_bar  = int(np.argmin(np.abs(times - exit_sec)))

        ax.axvline(x=entry_bar, color="#27ae60", lw=1.4, linestyle="--", alpha=0.7)
        ax.axvline(x=exit_bar,  color="#c0392b", lw=1.4, linestyle="--", alpha=0.7)
        ax.scatter([entry_bar], [y_entry], color="#27ae60", s=180, marker="*", zorder=5,
                   label=f"Entry  {_to_min_sec(entry_sec)}")
        ax.scatter([exit_bar],  [y_exit],  color="#c0392b", s=180, marker="*", zorder=5,
                   label=f"Exit   {_to_min_sec(exit_sec)}")

        ax.set_xticks(tick_pos)
        ax.set_xticklabels(tick_lbls, fontsize=8)
        ax.set_ylabel("Normalised score", fontsize=9)
        ax.set_xlim(0, n - 1)
        ax.set_ylim(-0.05, 1.15)
        color = "#27ae60" if role == "NOW PLAYING" else "#2980b9"
        ax.set_title(
            f"{role} — {track.track_id}  [{_to_min_sec(float(bars[0]))} → {_to_min_sec(float(bars[-1]))}]  "
            f"{len(bars)} bars  {track.tempo:.0f} BPM",
            fontsize=10, color=color, fontweight="bold",
        )
        ax.legend(fontsize=8, loc="upper left")
        ax.grid(axis="y", alpha=0.25)

    _draw_track(fig.add_subplot(gs[0]), track_a, entry_a, exit_a, "NOW PLAYING")
    _draw_track(fig.add_subplot(gs[1]), track_b, entry_b, exit_b, "UP NEXT")

    fig.suptitle("BeatBot — Cue Point Scores", fontsize=13, fontweight="bold")

    out_path = save_dir / "beatbot_cues.png"
    fig.savefig(out_path, dpi=130, bbox_inches="tight")
    plt.close(fig)

    # Open in the system default image viewer (non-blocking)
    import subprocess, os
    try:
        subprocess.Popen(["open", str(out_path)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass

    return out_path


def build_segment(
    audio: np.ndarray,
    sr: int,
    start_sec: float,
    end_sec: float,
) -> np.ndarray:
    """Return the audio slice from start_sec to end_sec."""
    start = max(0, int(start_sec * sr))
    end   = min(len(audio), int(end_sec * sr))
    return audio[start:end].copy()


def crossfade(
    seg_a: np.ndarray,
    seg_b: np.ndarray,
    fade_samples: int,
) -> np.ndarray:
    """
    Applies a linear crossfade between the tail of seg_a and the head of seg_b.

    Returns the blended transition segment (fade_samples long).
    seg_a must have ≥ fade_samples frames; seg_b too.
    """
    n = fade_samples
    if len(seg_a) < n:
        seg_a = np.pad(seg_a, ((0, n - len(seg_a)), (0, 0)))
    if len(seg_b) < n:
        seg_b = np.pad(seg_b, ((0, n - len(seg_b)), (0, 0)))

    fade_out = np.linspace(1.0, 0.0, n, dtype=np.float32)[:, np.newaxis]
    fade_in  = np.linspace(0.0, 1.0, n, dtype=np.float32)[:, np.newaxis]

    blend = seg_a[-n:] * fade_out + seg_b[:n] * fade_in
    return blend


def play_pair(
    track_a:    Track,
    track_b:    Track,
    audio_a:    np.ndarray,
    audio_b:    np.ndarray,
    entry_a:    float,
    exit_a:     float,
    entry_b:    float,
    fade_secs:  float = 7.0,
) -> np.ndarray:
    """
    Builds the continuous playback buffer for mixing track_a into track_b.

    Layout:
        [track_a from entry_a   →   exit_a]
        [       7-second linear crossfade  ]
        [track_b from entry_b+7s  →  end  ]

    Returns the full numpy buffer for this DJ moment.
    """
    fade_n = int(fade_secs * TARGET_SR)

    seg_a_body  = build_segment(audio_a, TARGET_SR, entry_a, exit_a)
    seg_a_tail  = build_segment(audio_a, TARGET_SR, exit_a,  exit_a + fade_secs)
    seg_b_head  = build_segment(audio_b, TARGET_SR, entry_b, entry_b + fade_secs)
    seg_b_body  = build_segment(audio_b, TARGET_SR, entry_b + fade_secs, len(audio_b) / TARGET_SR)

    transition = crossfade(seg_a_tail, seg_b_head, fade_n)

    return np.concatenate([seg_a_body, transition, seg_b_body], axis=0)


def play_blocking(buffer: np.ndarray, sr: int) -> bool:
    """
    Streams the buffer through sounddevice.
    Returns True if playback completed, False if interrupted by Ctrl-C.
    """
    stop_event = threading.Event()

    try:
        sd.play(buffer, samplerate=sr, blocking=False)

        # Progress ticker in main thread while audio plays
        total_secs   = len(buffer) / sr
        start_wall   = time.monotonic()
        tick_interval = 0.5

        while sd.get_stream().active:
            elapsed = time.monotonic() - start_wall
            pct     = min(elapsed / total_secs, 1.0)
            bar_len = 40
            filled  = int(pct * bar_len)
            bar     = "█" * filled + "░" * (bar_len - filled)
            print(f"\r  {CYN}▶{RST}  {bar}  {fmt_time(elapsed)} / {fmt_time(total_secs)} ", end="", flush=True)
            time.sleep(tick_interval)

        print()  # newline after progress bar
        return True

    except KeyboardInterrupt:
        sd.stop()
        print(f"\n  {YLW}[skip]{RST} Skipping to next track…")
        return False


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="BeatBot CLI DJ Player")
    parser.add_argument("--queue",    type=int,  default=0,     help="Number of songs to queue (0 = all)")
    parser.add_argument("--fade",     type=float, default=7.0,  help="Crossfade duration in seconds")
    parser.add_argument("--no-model", action="store_true",      help="Skip model, use heuristic cues only")
    args = parser.parse_args()

    print(f"\n{BOLD}{CYN}  ██████╗ ███████╗ █████╗ ████████╗██████╗  ██████╗ ████████╗{RST}")
    print(f"{BOLD}{CYN}  ██╔══██╗██╔════╝██╔══██╗╚══██╔══╝██╔══██╗██╔═══██╗╚══██╔══╝{RST}")
    print(f"{BOLD}{CYN}  ██████╔╝█████╗  ███████║   ██║   ██████╔╝██║   ██║   ██║   {RST}")
    print(f"{BOLD}{CYN}  ██╔══██╗██╔══╝  ██╔══██║   ██║   ██╔══██╗██║   ██║   ██║   {RST}")
    print(f"{BOLD}{CYN}  ██████╔╝███████╗██║  ██║   ██║   ██████╔╝╚██████╔╝   ██║   {RST}")
    print(f"{BOLD}{CYN}  ╚═════╝ ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚═════╝  ╚═════╝    ╚═╝   {RST}")
    print(f"\n  {DIM}AI DJ  ·  {args.fade:.0f}s crossfades{RST}\n")

    # 1. Load model ----------------------------------------------------------
    model = None
    if not args.no_model:
        if MODEL_FILE.exists():
            try:
                from model.lightgbm import BeatBotModel
                model = BeatBotModel(models_dir=str(MODEL_DIR))
                model.load(MODEL_FILE.name)
                print(f"  {GRN}✓{RST}  Model loaded from {MODEL_FILE.name}")
            except Exception as e:
                print(f"  {YLW}⚠{RST}   Could not load model ({e}). Falling back to heuristic cues.")
        else:
            print(f"  {YLW}⚠{RST}   No trained model found at {MODEL_FILE}.")
            print(f"       Run {CYN}python src/train.py{RST} to train one first.")
            print(f"       Continuing with heuristic cue detection.\n")

    # 2. Load tracks ---------------------------------------------------------
    print(f"  Scanning tracks…", end=" ", flush=True)
    all_tracks = load_tracks_with_audio()
    print(f"{GRN}{len(all_tracks)} tracks found.{RST}")

    if len(all_tracks) < 2:
        print(f"  {RED}✗{RST}  Need at least 2 tracks with audio. Exiting.")
        sys.exit(1)

    # 3. Build queue ---------------------------------------------------------
    random.shuffle(all_tracks)
    queue = all_tracks[:args.queue] if args.queue > 0 else all_tracks
    if len(queue) < 2:
        queue = all_tracks[:2]

    print(f"\n  {BOLD}Queue ({len(queue)} tracks):{RST}")
    for i, t in enumerate(queue):
        label = f"  {DIM}{i+1:2d}.{RST} {t.track_id}"
        print(label)

    print(f"\n  {DIM}Press Ctrl-C to skip a track, Ctrl-C twice to quit.{RST}\n")
    time.sleep(1)

    # 4. Pre-load first track's audio ----------------------------------------
    print(f"  {DIM}Loading audio…{RST}", end=" ", flush=True)
    audio_curr, sr = load_audio(Path(queue[0].audio_path))
    print(f"{GRN}done.{RST}")

    # 5. DJ loop -------------------------------------------------------------
    quit_flag = False
    for idx in range(len(queue) - 1):
        if quit_flag:
            break

        track_a = queue[idx]
        track_b = queue[idx + 1]

        # Predict cues
        entry_a, exit_a = predict_cues(track_a, model)
        entry_b, exit_b = predict_cues(track_b, model)

        # Render cue-score chart for both tracks (opens in Preview, non-blocking)
        try:
            chart_path = plot_cue_scores(
                track_a, track_b, model,
                entry_a, exit_a, entry_b, exit_b,
            )
            print(f"  {DIM}Chart saved → {chart_path}{RST}")
        except Exception as _chart_err:
            print(f"  {YLW}[warn]{RST} Chart generation failed: {_chart_err}")

        print(f"\n  {BOLD}{'─'*60}{RST}")
        print(f"  {GRN}NOW PLAYING{RST}  {BOLD}{track_a.track_id}{RST}")
        print(f"            {DIM}tempo  {track_a.tempo:.1f} BPM  ·  "
              f"entry {fmt_time(entry_a)}  ·  exit {fmt_time(exit_a)}{RST}")
        print(f"  {CYN}UP NEXT  {RST}  {track_b.track_id}")
        print(f"            {DIM}entry {fmt_time(entry_b)}{RST}")
        print()

        # Pre-load next track's audio in background
        audio_next_holder = [None]
        def _preload():
            audio_next_holder[0], _ = load_audio(Path(track_b.audio_path))
        preload_thread = threading.Thread(target=_preload, daemon=True)
        preload_thread.start()

        # Build playback buffer (non-blocking while we wait for preload)
        preload_thread.join()  # ensure loaded before building buffer
        audio_next = audio_next_holder[0]

        # Guard: exit cue must leave room for the fade
        track_dur_a = len(audio_curr) / TARGET_SR
        exit_a = min(exit_a, track_dur_a - args.fade - 0.5)
        exit_a = max(exit_a, entry_a + 4.0)  # at least 4s of A

        buf = play_pair(
            track_a   = track_a,
            track_b   = track_b,
            audio_a   = audio_curr,
            audio_b   = audio_next,
            entry_a   = entry_a,
            exit_a    = exit_a,
            entry_b   = entry_b,
            fade_secs = args.fade,
        )

        try:
            play_blocking(buf, TARGET_SR)
        except KeyboardInterrupt:
            try:
                print(f"\n  {YLW}Press Ctrl-C again within 2s to quit…{RST}")
                time.sleep(2)
            except KeyboardInterrupt:
                quit_flag = True
                print(f"\n  {RED}Stopping BeatBot.{RST}\n")

        # Reuse pre-loaded audio as current for next iteration
        audio_curr = audio_next

    # Last track (no next to mix into) ---------------------------------------
    if not quit_flag and len(queue) > 0:
        last = queue[-1]
        entry_last, _ = predict_cues(last, model)
        print(f"\n  {BOLD}{'─'*60}{RST}")
        print(f"  {GRN}FINAL TRACK{RST}  {BOLD}{last.track_id}{RST}\n")
        audio_last = audio_curr  # already loaded from previous iteration
        start_sample = max(0, int(entry_last * TARGET_SR))
        try:
            play_blocking(audio_last[start_sample:], TARGET_SR)
        except KeyboardInterrupt:
            sd.stop()

    print(f"\n  {CYN}BeatBot session ended.{RST}\n")


if __name__ == "__main__":
    main()
