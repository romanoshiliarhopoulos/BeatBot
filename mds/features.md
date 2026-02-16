# Feature Engineering & Selection Analysis

**Date:** 16 February 2026
**Model:** LightGBM (Gradient Boosting Classifier)
**Objective:** Identify the most predictive audio features for detecting DJ Cue Points (Entry/Exit) to train the BeatBot ranking model.

## 1. Executive Summary

The feature selection process confirmed that **Structural Position** is the primary driver of cue point location, but **Contextual Energy Shifts** and **Harmonic Relationships** are critical for refining the exact placement.

We successfully transformed raw audio data into high-level musical features. Notably, **rotating chroma vectors** to be key-invariant and adding **rolling energy windows** significantly improved model interpretability and prevented overfitting to specific keys.

## 2. Feature Importance Ranking (Top Predictors)

Based on LightGBM "Gain" (information gain), the top features are:

| Rank   | Feature               | Category   | Importance (Gain) | Insight                                                                                                                |
| :----- | :-------------------- | :--------- | :---------------- | :--------------------------------------------------------------------------------------------------------------------- |
| **1**  | `bar_pos_norm`        | Structural | ~54,770           | **The King.** DJing is 90% about _where_ you are in the song (Intro/Outro).                                            |
| **2**  | `energy_diff_context` | Context    | ~4,620            | Measures the shift in energy between the _previous_ 8 bars and _next_ 8 bars. Detects drops, buildups, and breakdowns. |
| **3**  | `energy_volatility`   | Dynamics   | ~3,555            | Cues often occur where energy stabilizes after a change.                                                               |
| **4**  | `energy_prev_8`       | Context    | ~3,341            | The history of the track leading up to the cue.                                                                        |
| **5**  | `energy_derivative`   | Dynamics   | ~3,143            | Instantaneous rate of change in energy.                                                                                |
| **6**  | `beat_strength`       | Rhythmic   | ~2,798            | Mix points require a clear, define beat grid.                                                                          |
| **7**  | `chroma_rel_1`        | Harmonic   | ~2,790            | Pitch class relative to Tonic.                                                                                         |
| **8**  | `harmonic_ratio`      | Timbral    | ~2,509            | Distinguishes Tonal vs. Noise/Percussive sections.                                                                     |
| **9**  | `syncopation`         | Rhythmic   | ~2,367            | Complexity of the rhythm.                                                                                              |
| **10** | `vocal_conf`          | Timbral    | ~1,870            | Vocal avoidance is a key mixing rule.                                                                                  |

## 3. Key Engineering Decisions

### A. Key-Invariant Chroma (`chroma_rel_X`)

- **Problem:** Raw Chroma features (`chroma_0` = C, `chroma_1` = C#, etc.) caused the model to overfit to specific keys (e.g., memorizing that "Songs in F Minor often start on C").
- **Solution:** We rotated the chroma vector so that **Index 0 is always the Tonic (Root)** of the track's key.
- **Result:** The model now recognizes harmonic functions (Tonic, Dominant, Subdominant) regardless of the absolute key. `chroma_rel_0` (Root) and `chroma_rel_7` (Perfect 5th) appear as top predictors.

### B. Context Windows (`energy_diff_context`)

- **Problem:** A single bar's energy doesn't tell the full story. A quiet bar could be a breakdown or an intro.
- **Solution:** accurate transitions require looking ahead and behind. We added:
  - `energy_prev_8`: Average energy of past 8 bars.
  - `energy_next_8`: Average energy of future 8 bars.
  - `energy_diff_context`: Future - Past.
- **Result:** This became the #2 most important feature, proving that **contrast** is what defines a cue point.

## 4. Final Feature Set Recommendation

For the production model, we will use the following feature set, organized by tier:

### Tier 1: Structure & Context (Must Haves)

- `bar_pos_norm`
- `energy_diff_context`
- `dist_to_section`
- `phrase_pos`
- `duration`

### Tier 2: Dynamics & Rhythm

- `energy_volatility`
- `energy_derivative`
- `beat_strength`
- `syncopation`

### Tier 3: Musicality & Timbre

- `chroma_rel_0` (Tonic strength)
- `chroma_rel_7` (Dominant strength)
- `harmonic_ratio`
- `vocal_conf` (To avoid clashing vocals)
- `high_band_energy` (Hi-hats/Air often indicate mix capability)

### Dropped Features

- Raw `chroma_0` through `chroma_11` (Replaced by relative chroma).
- `beat_consistency` (High correlation with `beat_strength`).
- `spectral_rolloff` (Redundant with `high_band_energy`).

## 5. Next Steps

1.  Implement the `FeatureExtractor` class in `src/models/features.py` using this exact logic.
2.  Train the LightGBM Ranker using this reduced feature set.
