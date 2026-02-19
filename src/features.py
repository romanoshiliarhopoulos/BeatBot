import numpy as np
import pandas as pd
from typing import List, Dict, Any

from track import Track

class FeatureExtractor:
    """
    Centralized feature extraction logic for BeatBot models.
    Ensures that training and inference use the exact same feature engineering pipeline.
    """
    
    # Define the exact features used by the model to ensure consistency
    FEATURES = [
        # Tier 1: Structure
        'bar_pos_norm', 'dist_to_section', 'phrase_pos', 'duration',
        
        # Tier 2: Energy & Dynamics
        'energy_diff_context', 'energy_prev_8', 'energy_next_8',
        'energy_volatility', 'energy_derivative', 'beat_strength',
        
        # Tier 3: Musical Content
        'spectral_centroid', 'spectral_flatness',  
        'high_band_energy', 'mid_band_energy', 
        'harmonic_ratio', 'vocal_conf', 'syncopation', 'key_conf', 

        # Tier 4: Chroma / Key (Specific Intervals)
        'chroma_rel_0', 'chroma_rel_3', 'chroma_rel_7', 
        'chroma_rel_9', 'chroma_rel_11',

        # Tier 5: Rhythmic Grid & Phrasing
        'is_4_bar', 'bar_mod_8', 'bar_mod_16', 'bar_mod_32',
        
        # Tier 6: Flux & Change
        'energy_ratio_8', 'energy_flux', 'spectral_flux',
        
        # Tier 7: Advanced Context (The "Human" Features)
        'energy_contrast_future',   # Is a drop coming?
        'is_likely_breakdown',      # Low bass, high mids?
        'vocal_future_8',           # Vocals incoming? (Don't exit)
        'vocal_past_8',             # Vocals just finished? (Ready to exit)

        # Tier 8: Previously Unused Track Fields
        'is_section_start',         # Boolean: track.is_section_start
        'beat_consistency',         # Regularity of kick pattern
        'percussion_intensity',     # Isolated percussion loudness
        'vocal_onset_likelihood',   # Probability vocals start in next 4 bars
        'spectral_rolloff',         # Frequency below which 85% energy lies
        'melodic_complexity',       # Number of active harmonic peaks

        # Tier 9: Composite
        'phrase_boundary_strength', # How many grid alignments fire simultaneously (0-5)
    ]

    @staticmethod
    def extract(track: Track) -> pd.DataFrame:
        """
        Extracts a DataFrame of features (one row per bar) from a single Track object.
        """
        # --- Pre-calculation ---
        # Section Lookups
        sorted_section_starts = sorted(track.sections.keys()) if track.sections else []
        
        # Series conversions
        zeros = np.zeros(track.num_bars)
        energy_series = pd.Series(track.energy_per_bar) if track.energy_per_bar is not None else pd.Series(zeros)
        low_band = pd.Series(track.low_band_energy) if track.low_band_energy is not None else pd.Series(zeros)
        vocal_series = pd.Series(track.vocal_activity_confidence) if track.vocal_activity_confidence is not None else pd.Series(zeros)
        
        # Rolling Windows
        energy_prev_8_mean = energy_series.rolling(window=8, min_periods=1).mean().to_numpy()
        energy_next_8 = energy_series.shift(-8).rolling(window=8, min_periods=1).mean().fillna(0).to_numpy() # Shifted Mean
        
        # Advanced Context Calculations
        # Future Contrast: (Next 16 bars energy) / (Current 8 bars energy)
        # We need next 16 bars sum/mean
        energy_next_16_mean = energy_series.shift(-16).rolling(window=16, min_periods=1).mean().fillna(0).to_numpy()
        
        # Vocal Context
        vocal_future_8 = vocal_series.shift(-8).rolling(window=8, min_periods=1).max().fillna(0).to_numpy()
        vocal_past_8 = vocal_series.rolling(window=8, min_periods=1).max().fillna(0).to_numpy()

        energy_prev_1 = energy_series.shift(1).fillna(0).to_numpy()
        spectral_series = pd.Series(track.spectral_centroid) if track.spectral_centroid is not None else pd.Series(zeros)
        spectral_prev_1 = spectral_series.shift(1).fillna(0).to_numpy()

        # Pre-compute section-start lookup (O(1) per bar)
        section_start_set = set(track.sections.keys()) if track.sections else set()
        
        # Chroma Rotation Setup
        # Note: Valid for offline processing. For real-time, this would need a buffer.
        energy_next_8 = energy_series.shift(-8).rolling(window=8, min_periods=1).mean().to_numpy()
        energy_next_8 = np.nan_to_num(energy_next_8)
        
        # Chroma Rotation
        # Detect global key shift needed to make C=0 align with Tonic
        # If key is unknown, we can't rotate, so we might fill with NaN or raw chroma (risk of noise)
        tonic_shift = 0
        has_key = False
        if track.key_tonic is not None:
            tonic_shift = int(track.key_tonic) % 12
            has_key = True

        data = []
        for i in range(track.num_bars):
            row = {
                'track_id': track.track_id,
                'bar_index': i,
            }

            # Helper for safe access
            def get_val(arr, idx, default=np.nan):
                if arr is None or idx >= len(arr):
                    return default
                val = arr[idx]
                return 1 if isinstance(val, (bool, np.bool_)) else val

            # --- A. Structural Features ---
            row['bar_pos_norm'] = track.bar_position_normalized[i]
            row['dist_to_section'] = get_val(track.distance_to_section_boundary, i)
            row['phrase_pos'] = get_val(track.phrase_position, i)
            row['duration'] = track.duration
            row['is_4_bar'] = 1 if (i % 4 == 0) else 0
            row['bar_mod_8'] = 1 if (i % 8 == 0) else 0
            row['bar_mod_16'] = 1 if (i % 16 == 0) else 0
            row['bar_mod_32'] = 1 if (i % 32 == 0) else 0

            # --- B. Energy Features ---
            row['energy'] = get_val(track.energy_per_bar, i)
            row['energy_prev_8'] = energy_prev_8_mean[i]
            row['energy_next_8'] = energy_next_8[i]
            row['energy_diff_context'] = row['energy_next_8'] - row['energy_prev_8']
            row['energy_ratio_8'] = row['energy'] / row['energy_prev_8'] if row['energy_prev_8'] > 0 else 0
            row['energy_flux'] = abs(row['energy'] - energy_prev_1[i])
            
            row['energy_volatility'] = get_val(track.energy_volatility, i)
            row['energy_derivative'] = get_val(track.energy_derivative, i)

            # --- C. Musical/Timbral Features ---
            row['beat_strength'] = get_val(track.beat_strength, i)
            row['harmonic_ratio'] = get_val(track.harmonic_ratio, i)
            row['vocal_conf'] = get_val(track.vocal_activity_confidence, i)
            row['high_band_energy'] = get_val(track.high_band_energy, i)
            row['mid_band_energy'] = get_val(track.mid_band_energy, i)
            row['syncopation'] = get_val(track.syncopation, i)
            row['spectral_centroid'] = get_val(track.spectral_centroid, i)
            row['spectral_flatness'] = get_val(track.spectral_flatness, i)
            
            # Additional Content Measures
            row['spectral_flux'] = abs(row['spectral_centroid'] - spectral_prev_1[i])
            row['key_conf'] = track.key_confidence if track.key_confidence is not None else 0.0
            
            # --- D. Advanced Context Features (Tier 7) ---
            # Is a drop coming? Compare future energy to current
            # If next 8 bars are much louder than current, it's a build-up
            curr_energy = row['energy_prev_8'] if row['energy_prev_8'] > 0 else 0.001
            row['energy_contrast_future'] = energy_next_16_mean[i] / curr_energy
            
            # Is this a breakdown? (Low bass, high mids/highs)
            # Breakdown usually means Low Band is < X% of Total Energy
            low_e = get_val(track.low_band_energy, i, 0)
            total_e = row['energy'] if row['energy'] > 0.001 else 1.0
            row['is_likely_breakdown'] = 1 if (low_e / total_e) < 0.3 else 0
            
            # Vocals logic: Don't exit if vocals are starting soon
            row['vocal_future_8'] = vocal_future_8[i]
            row['vocal_past_8'] = vocal_past_8[i]

            # --- E. Previously Unused Track Fields (Tier 8) ---
            row['is_section_start']       = 1 if i in section_start_set else 0
            row['beat_consistency']       = get_val(track.beat_consistency, i, default=0.0)
            row['percussion_intensity']   = get_val(track.percussion_intensity, i, default=0.0)
            row['vocal_onset_likelihood'] = get_val(track.vocal_onset_likelihood, i, default=0.0)
            row['spectral_rolloff']       = get_val(track.spectral_rolloff, i, default=0.0)
            row['melodic_complexity']     = get_val(track.melodic_complexity, i, default=0.0)

            # --- F. Composite: Phrase Boundary Strength (Tier 9) ---
            # Counts how many grid-alignment flags fire simultaneously (0–5).
            # High value = strong structural downbeat; ideal cue point candidate.
            row['phrase_boundary_strength'] = (
                row['is_4_bar']
                + row['bar_mod_8']
                + row['bar_mod_16']
                + row['bar_mod_32']
                + row['is_section_start']
            )

            # --- G. Key-Invariant Chroma ---
            if track.chroma_vector is not None and i < len(track.chroma_vector) and has_key:
                chroma_raw = track.chroma_vector[i]
                chroma_rotated = np.roll(chroma_raw, -tonic_shift)
                # We specifically need index 0 (Tonic) and 7 (Dominant)
                row['chroma_rel_0'] = chroma_rotated[0]
                row['chroma_rel_3'] = chroma_rotated[3]
                row['chroma_rel_7'] = chroma_rotated[7]
                row['chroma_rel_9'] = chroma_rotated[9]
                row['chroma_rel_11'] = chroma_rotated[11]
            else:
                row['chroma_rel_0'] = np.nan
                row['chroma_rel_3'] = np.nan
                row['chroma_rel_7'] = np.nan
                row['chroma_rel_9'] = np.nan
                row['chroma_rel_11'] = np.nan

            # --- Targets (for training only) ---
            # Map cues to binary targets
            # Check if current bar is in cue_in or cue_out lists
            # We assume cue_in/cue_out are lists of bar indices or timestamps mapped to indices
            # For simplicity, assuming track.cue_in contains bar indices or we convert them
            # In the notebook we did: np.searchsorted
            is_cue_in = 0
            is_cue_out = 0
            
            # Simple check if current bar is close to a cue point
            # Note: This requires track.cue_in to be bar indices. 
            # If they are timestamps, we need conversion. 
            # Assuming track.cue_in are timestamps, we convert:
            # But wait, looking at extraction logic in notebook:
            # idxs = np.searchsorted(t.bars, t.cue_in)
            # So track.cue_in stores timestamps.
            
            # Let's do the conversion once per track (outside loop)
            # For this simple row-by-row, we can just check if i is in a pre-computed set
            # This is handled by the `extract_labels` method or similar, 
            # but here we just extracting features. 
            # We'll return features only. Labels should be handled by the caller/trainer.
            
            data.append(row)

        return pd.DataFrame(data)

    @staticmethod
    def extract_labels(track: Track) -> pd.DataFrame:
        """
        Extracts graded relevance labels for LambdaRank training.

        Relevance scale (higher = more relevant):
          2 = exact cue bar
          1 = within ±2 bars of a cue (musically acceptable alternative)
          0 = not a cue

        Graded labels let LambdaRank optimise NDCG properly: it can distinguish
        "ranked the exact cue first" from "ranked a near-miss first", which is
        far more informative than the previous binary 0/1 signal.
        """
        labels = []

        # Convert timestamps to bar indices
        cue_in_idxs = set()
        if len(track.cue_in) > 0:
            idxs = np.searchsorted(track.bars, track.cue_in)
            idxs = np.clip(idxs, 0, track.num_bars - 1)
            cue_in_idxs.update(idxs.tolist())

        cue_out_idxs = set()
        if len(track.cue_out) > 0:
            idxs = np.searchsorted(track.bars, track.cue_out)
            idxs = np.clip(idxs, 0, track.num_bars - 1)
            cue_out_idxs.update(idxs.tolist())

        WINDOW = 2  # bars either side of exact cue that count as grade-1

        for i in range(track.num_bars):
            # Entry relevance
            if i in cue_in_idxs:
                rel_in = 2
            elif any(abs(i - idx) <= WINDOW for idx in cue_in_idxs):
                rel_in = 1
            else:
                rel_in = 0

            # Exit relevance
            if i in cue_out_idxs:
                rel_out = 2
            elif any(abs(i - idx) <= WINDOW for idx in cue_out_idxs):
                rel_out = 1
            else:
                rel_out = 0

            labels.append({
                'track_id':  track.track_id,
                'bar_index': i,
                'is_cue_in':  rel_in,
                'is_cue_out': rel_out,
            })

        return pd.DataFrame(labels)
