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
        'chroma_rel_0', 'chroma_rel_7', 'harmonic_ratio', 
        'vocal_conf', 'high_band_energy', 'syncopation',
        # Tier 4: Rhythmic Grid
        'is_4_bar'
    ]

    @staticmethod
    def extract(track: Track) -> pd.DataFrame:
        """
        Extracts a DataFrame of features (one row per bar) from a single Track object.
        """
        # --- Pre-calculation ---
        # Section Lookups
        sorted_section_starts = sorted(track.sections.keys()) if track.sections else []
        
        # Rolling Energy
        # rolling window calculation
        energy_series = pd.Series(track.energy_per_bar) if track.energy_per_bar is not None else pd.Series(np.zeros(track.num_bars))
        
        # History: Mean of previous 8 bars
        energy_prev_8 = energy_series.rolling(window=8, min_periods=1).mean().to_numpy() # shape (N,)
        
        # Future: Mean of next 8 bars (shift backward by 8, then rolling mean)
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

            # --- B. Energy Features ---
            row['energy'] = get_val(track.energy_per_bar, i)
            row['energy_prev_8'] = energy_prev_8[i]
            row['energy_next_8'] = energy_next_8[i]
            row['energy_diff_context'] = row['energy_next_8'] - row['energy_prev_8']
            
            row['energy_volatility'] = get_val(track.energy_volatility, i)
            row['energy_derivative'] = get_val(track.energy_derivative, i)

            # --- C. Musical/Timbral Features ---
            row['beat_strength'] = get_val(track.beat_strength, i)
            row['harmonic_ratio'] = get_val(track.harmonic_ratio, i)
            row['vocal_conf'] = get_val(track.vocal_activity_confidence, i)
            row['high_band_energy'] = get_val(track.high_band_energy, i)
            row['syncopation'] = get_val(track.syncopation, i)

            # --- D. Key-Invariant Chroma ---
            if track.chroma_vector is not None and i < len(track.chroma_vector) and has_key:
                chroma_raw = track.chroma_vector[i]
                chroma_rotated = np.roll(chroma_raw, -tonic_shift)
                # We specifically need index 0 (Tonic) and 7 (Dominant)
                row['chroma_rel_0'] = chroma_rotated[0]
                row['chroma_rel_7'] = chroma_rotated[7]
            else:
                row['chroma_rel_0'] = np.nan
                row['chroma_rel_7'] = np.nan

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
        Extracts the target labels (is_cue_in, is_cue_out) for a track.
        Returns a DataFrame with ['track_id', 'bar_index', 'is_cue_in', 'is_cue_out']
        """
        labels = []
        
        # Convert timestamps to indices
        cue_in_idxs = set()
        if len(track.cue_in) > 0:
            idxs = np.searchsorted(track.bars, track.cue_in)
            idxs = np.clip(idxs, 0, track.num_bars - 1)
            cue_in_idxs.update(idxs)

        cue_out_idxs = set()
        if len(track.cue_out) > 0:
            idxs = np.searchsorted(track.bars, track.cue_out)
            idxs = np.clip(idxs, 0, track.num_bars - 1)
            cue_out_idxs.update(idxs)

        for i in range(track.num_bars):
            labels.append({
                'track_id': track.track_id,
                'bar_index': i,
                'is_cue_in': 1 if i in cue_in_idxs else 0,
                'is_cue_out': 1 if i in cue_out_idxs else 0
            })
            
        return pd.DataFrame(labels)
