# Audio Feature Engineering

Feature Engineering is the most critical component of the BeatBot pipeline. The `FeatureExtractor` class (`src/features.py`) transforms raw audio signals into 40+ high-level musical descriptors optimized for mixing decisions.

## 1. Feature Philosophy
To mimic a human DJ, the features must capture three dimensions:
1.  **Structure**: "Where am I in the song?" (Intro, Outro, Breakdown).
2.  **Context**: "What just happened and what is coming next?" (Drops, Buildups).
3.  **Harmonic Function**: "Does this section sound resolved (Tonic) or tense (Dominant)?"

## 2. Feature Tiers
The features are organized into 9 distinct tiers.

### Tier 1: Structure (The "Where")
*   `bar_pos_norm`: Normalized position (0.0 to 1.0). The strongest predictor for Entry/Exit cues.
*   `dist_to_section`: Distance (in bars) to the nearest structural boundary (e.g., Chorus/Verse change).
*   `phrase_pos`: Position within the current 32-bar phrase.
*   `duration`: Total track length.

### Tier 2: Energy & Dynamics (The "Vibe")
*   `energy_diff_context`: Difference between future energy (Next 8 bars) and past energy (Prev 8 bars). Detects transitions.
*   `energy_volatility`: Standard deviation of energy. Low volatility = stable mixing point.
*   `energy_derivative`: Rate of change in loudness.
*   `beat_strength`: Clarity of the beat grid.

### Tier 3: Timbre & Content
*   `harmonic_ratio`: Balance between tonal (melody) and noise (percussion) components.
*   `spectral_flatness`: "Noisiness" of the sound.
*   `vocal_conf`: **Critical.** Confidence score for vocal presence. DJs avoid mixing over vocals.
*   `high_band_energy`: Presence of Hi-Hats/Cymbals (often indicates a mixable section).

### Tier 4: Key-Invariant Chroma (The "Harmony")
Raw chroma features (C, C#, D...) are rotated based on the track's Key Tonic.
*   `chroma_rel_0`: Strength of the Tonic (Root) note.
*   `chroma_rel_7`: Strength of the Dominant (5th) note.
*   *Why?* This allows the model to learn harmonic functions (e.g., "Mix out when the song resolves to Tonic") regardless of the actual musical key (Am, F#m, etc.).

### Tier 5: Rhythmic Grid
*   `is_4_bar`, `bar_mod_8`, `bar_mod_16`, `bar_mod_32`: Boolean flags for grid alignment.
*   *Use:* Enforces phrasing rules (e.g., "Always mix on the 1").

### Tier 6: Flux & Change
*   `energy_flux`: Instantaneous fluctuation in loudness.
*   `spectral_flux`: Instantaneous change in timbre (e.g., a crash cymbal).

### Tier 7: Advanced Context (The "Human" Features)
*   `energy_contrast_future`: Ratio of future energy to current. Specifically designed to predict drops.
*   `is_likely_breakdown`: Heuristic based on Low/Mid energy ratios.
*   `vocal_future_8`: Look-ahead feature. "Are vocals starting in 8 bars?" (If yes, don't mix out yet).
*   `vocal_past_8`: Look-behind feature. "Did vocals just finish?" (If yes, good time to mix out).

### Tier 8: Track Metadata
*   `is_section_start`: Boolean flag from the section segmentation algorithm.
*   `beat_consistency`: Stability of the tempo/grid.

### Tier 9: Composite Features
*   `phrase_boundary_strength`: A sum (0-5) of all rhythmic grid flags. Higher score = Stronger structural downbeat (e.g., the "1" of a 32-bar phrase).

## 3. Engineering Details

### Consistency
The `FeatureExtractor` ensures that training and inference use identical logic. This is crucial for avoiding skew, especially with:
*   **NaN Handling:** Consistent zero-filling or mean-imputation.
*   **Rolling Windows:** Ensuring look-ahead windows (`shift(-8)`) are handled correctly at the end of tracks.

### Implementation
All extraction logic is centralized in:
`src/features.py` -> `FeatureExtractor.extract(track)`
