# Beyond the Crossfade: A Transition Engine for BeatBot

## Current State

BeatBot's transitions are **linear gain crossfades** in the Web Audio frontend (`useAudioEngine.ts`). The outgoing deck ramps gain from 1 → 0 while the incoming deck ramps 0 → 1 over a user-selected duration (3–15s). Nothing else changes: no EQ shaping, no filtering, no beat-sync, no effects.

This works, but every mix sounds the same regardless of what's happening musically. A transition out of a high-energy drop sounds identical to one leaving a stripped-back breakdown. Professional DJs never do this — they adapt their technique to the musical context.

---

## What We Already Have (and Aren't Using)

BeatBot already extracts **53 features per bar** that describe exactly the kind of musical context a smarter transition engine needs:

| Available Signal | Feature(s) | Transition Relevance |
|---|---|---|
| Energy profile | `energy_prev_8`, `energy_next_8`, `energy_diff_context`, `energy_contrast_future` | Determines if we're leaving a peak, entering a build, or sitting in a valley |
| Frequency balance | `high_band_energy`, `mid_band_energy`, `low_band_energy`, `harmonic_ratio` | Drives EQ crossfade decisions (swap bass first? highs first?) |
| Vocal presence | `vocal_conf`, `vocal_future_8`, `vocal_past_8` | Avoid clashing vocals; prioritize clean handoffs |
| Rhythmic stability | `beat_consistency`, `percussion_intensity`, `syncopation` | Safe to overlap kicks or not? |
| Structural position | `phrase_pos`, `bar_mod_8/16/32`, `is_section_start`, `phrase_boundary_strength` | Snap transitions to musically meaningful boundaries |
| Timbral character | `spectral_centroid`, `spectral_flatness`, `spectral_rolloff` | Match or contrast brightness between tracks |
| Key/harmony | `chroma_rel_*`, `key_conf` | Detect harmonic compatibility for blend vs. hard-cut decisions |

The insight: **the ML model already uses these features to pick _where_ to transition. The same features should drive _how_ to transition.**

---

## Proposed Transition Types

### 1. EQ Crossfade (Bass Swap)

**The most impactful upgrade.** Instead of a simple volume crossfade, use Web Audio `BiquadFilterNode` to independently control low/mid/high bands per deck.

**Technique:** Swap the bass first, then blend the mids and highs.

```
Timeline:  |---- fade_secs ----|
Bass:      A ████░░░░ B        (cut at ~30% through)
Mids:      A ██████░░░░ B      (linear ramp)
Highs:     A ████████░░░░ B    (delayed start)
```

**When to use:** High `percussion_intensity` on both tracks + high `beat_consistency` on both. This is the bread-and-butter house music transition — two 4-on-the-floor kicks should never overlap, so you cut the outgoing bass cleanly rather than blending it.

**Web Audio implementation sketch:**
```
Source → LowShelf (< 250 Hz)  → GainNode (low)  ─┐
Source → BandPass (250–4kHz)  → GainNode (mid)  ──┤→ destination
Source → HighShelf (> 4kHz)   → GainNode (high) ─┘
```

Each band gets its own gain automation curve. The bass swap happens on a phrase boundary (`bar_mod_8 == 1`), while mids and highs blend over the full fade duration.

**Key feature triggers:**
- `percussion_intensity` > threshold on both decks → bass swap instead of blend
- `beat_consistency` > 0.7 → snap bass cut to beat grid
- `low_band_energy` ratio between tracks → determines swap aggressiveness

---

### 2. Filter Sweep Transition

**Technique:** Apply a low-pass filter to the outgoing track (sweeping the cutoff frequency from 20kHz down to ~200Hz) while the incoming track enters unfiltered (or with a complementary high-pass sweep opening up).

```
Outgoing:  LPF cutoff  20kHz ──────► 200Hz
Incoming:  HPF cutoff  4kHz  ──────► 20Hz (fully open)
```

**When to use:** When transitioning out of a breakdown (`is_likely_breakdown == 1`) or when `spectral_centroid` is high (bright track) and needs to be "dimmed" before the next track lands. Also effective when `vocal_conf` is high on the outgoing track — the filter naturally ducks vocals without an abrupt cut.

**Web Audio:** Single `BiquadFilterNode` (type: "lowpass") per deck with `frequency` parameter automated via `exponentialRampToValueAtTime()`. Exponential ramps sound more natural for frequency sweeps than linear ones.

**Key feature triggers:**
- `vocal_conf` > 0.5 on outgoing → prefer filter sweep over hard EQ cut
- `spectral_centroid` difference between tracks is large → use filter to bridge the timbral gap
- `energy_contrast_future` > 1.5 → incoming track is significantly louder, filter masks the energy jump

---

### 3. Echo/Delay Fade-Out

**Technique:** As the outgoing track fades, feed it through a feedback delay that gradually increases in wet mix and feedback, creating a rhythmic echo tail that dissolves into the incoming track.

**When to use:** When exiting a section with high `syncopation` or at a section boundary (`is_section_start` on the incoming track). The echoes create a natural "space" between the two tracks rather than forcing them to overlap.

**Web Audio:** `DelayNode` + feedback `GainNode` loop + wet/dry `GainNode` mix. Delay time should be quantized to the beat grid: `60 / tempo` seconds for quarter-note echoes, or half that for eighth-notes.

```
Source → Dry Gain ────────────────────────┐
Source → Delay → Feedback Gain → Delay ──→┤→ Wet Gain → destination
                                          └────────────┘
```

**Key feature triggers:**
- `beat_strength` > 0.6 → sync delay to beat grid
- `syncopation` > threshold → use dotted or triplet delay times
- Outgoing `energy_derivative` < 0 (energy falling) → echo fade suits the natural decay
- `phrase_boundary_strength` >= 3 → strong structural boundary, echo creates separation

---

### 4. Power-Cut Drop

**Technique:** Hard silence (50–200ms) at a phrase boundary, then the incoming track lands on a downbeat. No overlap.

**When to use:** The incoming track's entry point has `phrase_boundary_strength` >= 4 AND `energy_contrast_future` shows a big energy jump (the classic "drop" moment). A crossfade would soften the impact. Silence amplifies it.

**Implementation:** Ramp both decks to 0 over ~50ms, hold silence, then snap incoming deck gain to 1 on the beat. The pause duration should be exactly one beat (`60 / tempo` seconds) for maximum rhythmic impact.

**Key feature triggers:**
- `energy_diff_context` > high threshold (massive energy increase at entry)
- `phrase_boundary_strength` >= 4 on incoming entry bar
- `percussion_intensity` is low before entry, high after (breakdown → drop)
- `is_section_start == 1` on incoming

---

### 5. Harmonic Blend (Long Mix)

**Technique:** Extended overlap (16–32 bars) with both tracks at near-full volume, relying on harmonic compatibility to avoid clashing.

**When to use:** When the two tracks are in compatible keys (`chroma_rel_0` and `chroma_rel_7` — tonic and dominant — are strong in both tracks) AND both are in low-energy sections (breakdowns, intros, outros). This is the "two tracks playing together for a while" technique that only works if the harmony cooperates.

**Implementation:** Instead of the standard gain ramp, use a **constant-power crossfade** (equal-power curve: `cos` for fade-out, `sin` for fade-in) to maintain perceived loudness during the extended overlap. Optionally reduce both gains to ~0.8 to prevent clipping.

```javascript
// Constant-power (equal-power) crossfade curves
outGain = Math.cos(t * Math.PI / 2)  // 1 → 0, but maintains energy
inGain  = Math.sin(t * Math.PI / 2)  // 0 → 1, but maintains energy
```

**Key feature triggers:**
- `key_conf` > 0.7 on both tracks + compatible `chroma_rel_*` profiles
- `energy_prev_8` is low on both tracks (both are in calm sections)
- `harmonic_ratio` > 0.6 on both (melodic content, not just percussion)
- `vocal_conf` < 0.3 on both (no vocal clash risk)

---

### 6. Adaptive Gain Curve (Improved Default)

Even without adding new audio nodes, the gain ramp shape itself can be smarter. The current linear ramp is the worst option — perceived loudness drops in the middle of the crossfade (the "volume dip" problem).

| Curve | Formula | Best For |
|---|---|---|
| **Linear** (current) | `t` | Nothing, honestly |
| **Equal-power** | `sin(t * pi/2)` / `cos(t * pi/2)` | General purpose — maintains perceived loudness |
| **S-curve** | `t^2 * (3 - 2t)` (smoothstep) | Slow, gradual transitions where you want both tracks audible mid-mix |
| **Exponential** | `e^(k*t)` normalized | Quick transitions where one track should dominate most of the fade |

The equal-power curve should **replace linear as the default** — it's strictly better for any simple volume crossfade.

Web Audio supports `setValueCurveAtTime()` which accepts a `Float32Array` of arbitrary gain values, so any curve shape is possible without needing multiple automation calls.

---

## Architecture: Transition Strategy Engine

Rather than hardcoding transition logic, introduce a **strategy pattern** that selects and configures transitions based on the musical context at the transition point.

### Data Flow

```
┌─────────────────────────────────────────────────────┐
│                  PREDICTION API                      │
│  (already returns entry_sec, exit_sec per track)     │
└──────────────┬──────────────────────────────────────┘
               │
               │  Add: outgoing track features at exit bar
               │       incoming track features at entry bar
               │
               ▼
┌─────────────────────────────────────────────────────┐
│            TRANSITION STRATEGY SELECTOR              │
│                                                      │
│  Inputs:                                             │
│    - outgoing bar features (energy, vocal, rhythm)   │
│    - incoming bar features (energy, vocal, rhythm)   │
│    - key compatibility score                         │
│    - tempo match confidence                          │
│                                                      │
│  Output:                                             │
│    TransitionConfig {                                │
│      type: "eq_swap" | "filter_sweep" | "echo_out"  │
│             | "power_cut" | "harmonic_blend"         │
│             | "crossfade"                            │
│      curve: "equal_power" | "linear" | "s_curve"    │
│      fadeSecs: number                                │
│      params: { ... type-specific }                   │
│    }                                                 │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────┐
│              WEB AUDIO TRANSITION ENGINE             │
│                                                      │
│  Builds the appropriate audio graph per transition:  │
│    - Creates/connects BiquadFilterNodes              │
│    - Creates/connects DelayNodes                     │
│    - Schedules parameter automation curves           │
│    - Snaps timing to beat grid when needed           │
└─────────────────────────────────────────────────────┘
```

### API Changes

The prediction endpoint already returns `entry_sec` and `exit_sec`. Extend it to also return a `transition` object:

```python
class TransitionConfig(BaseModel):
    type: str = "crossfade"           # transition technique
    curve: str = "equal_power"        # gain curve shape
    fade_secs: float = 7.0            # duration
    bass_swap_point: float | None     # 0.0–1.0 within fade where bass cuts
    filter_start_freq: float | None   # Hz, for filter sweep
    filter_end_freq: float | None     # Hz, for filter sweep
    delay_time_beats: float | None    # in beat multiples (1.0 = quarter note)
    silence_beats: float | None       # for power-cut, beats of silence
```

The backend computes this from the **already-extracted features** at the exit/entry bars. No new ML model needed — this is a rule-based decision tree on top of existing feature data.

### Frontend Audio Graph

Restructure `useAudioEngine.ts` to support a richer audio graph per deck:

```
Current:   Source → GainNode → destination

Proposed:  Source → LowShelf Filter → Low GainNode  ─┐
           Source → BandPass Filter → Mid GainNode  ──┼→ MasterGain → destination
           Source → HighShelf Filter → High GainNode ─┘
                                          │
                                     DelayNode (optional)
                                          │
                                     Wet GainNode (optional)
```

This is backwards-compatible: for a simple crossfade, all band gains move together and the delay is bypassed. The additional nodes only activate when a non-default transition is selected.

---

## Decision Matrix

A quick-reference for which transition to select based on feature values:

| Condition | Transition | Why |
|---|---|---|
| Both tracks have strong kicks (`percussion_intensity` > 0.6, `beat_consistency` > 0.7) | **EQ Bass Swap** | Overlapping kicks = mud |
| Outgoing has vocals (`vocal_conf` > 0.5) | **Filter Sweep** | Naturally ducks vocals without abrupt cut |
| Big energy drop → big energy rise at entry | **Power Cut** | Don't soften the drop |
| Both tracks in compatible keys, low energy | **Harmonic Blend** | Let them play together |
| Strong phrase boundary, rhythmic content | **Echo Fade-Out** | Creates space between sections |
| None of the above / fallback | **Equal-Power Crossfade** | Better than linear, always safe |

---

## Implementation Priority

1. **Replace linear with equal-power crossfade** — One-line change in `useAudioEngine.ts` using `setValueCurveAtTime()`. Immediate improvement, zero risk.

2. **3-band EQ per deck** — Add `BiquadFilterNode` chain to the audio graph. This unlocks bass swap and independent band control. Moderate effort, high impact.

3. **Transition strategy selector** — Backend returns `TransitionConfig` based on features at exit/entry bars. Rule-based, no ML needed.

4. **Filter sweep** — One additional `BiquadFilterNode` per deck with frequency automation.

5. **Echo/delay fade** — `DelayNode` + feedback loop. More complex audio graph but well-documented Web Audio pattern.

6. **Power cut** — Simplest to implement (it's _less_ code than a crossfade) but needs precise beat-grid timing, so it depends on the backend providing tempo and beat positions to the frontend.

---

## What This Doesn't Cover

- **Tempo matching / beatgrid sync** — BeatBot currently assumes compatible tempos. A pitch-shifting layer (Web Audio `playbackRate` or a `PitchShifterNode`) would be a separate initiative.
- **User override UX** — The frontend would need controls to let users pick transition type manually or preview alternatives. The selector auto-picks, but DJs want control.
- **Training a transition model** — The rule-based selector is the pragmatic first step. A learned model (predicting transition type from feature pairs) could come later once there's labeled data on what transitions sound good.
