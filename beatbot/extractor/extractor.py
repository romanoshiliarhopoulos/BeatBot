from pathlib import Path
from typing import Optional, Tuple
import numpy as np
import librosa
import json
from scipy import signal, fft
from scipy.stats import entropy
from tqdm.auto import tqdm

from beatbot.track import Track


class Extractor:
    """
    Extracts audio features and annotations to populate Track dataclass.
    """
    
    def __init__(
        self,
        sr: int = 44100,
        hop_length: int = 512,
        n_fft: int = 2048,
        n_mels: int = 128,
        enable_vocal_separation: bool = False
    ):
        """
        Initialize the feature extractor.
        
        Args:
            sr: Sample rate for audio loading
            hop_length: Number of samples between frames
            n_fft: FFT window size
            n_mels: Number of mel bands
            enable_vocal_separation: Whether to use Demucs/Spleeter (slow, requires GPU)
        """
        self.sr = sr
        self.hop_length = hop_length
        self.n_fft = n_fft
        self.n_mels = n_mels
        self.enable_vocal_separation = enable_vocal_separation
        
    def extract(
        self,
        audio_path: Path | str,
        annotation_path: Optional[Path | str] = None,
        track_id: Optional[str] = None,
        source: str = "local"
    ) -> Track:
        """
        Extract all features from audio file and create Track object.
        
        Args:
            audio_path: Path to MP3/WAV audio file
            annotation_path: Optional path to JAMS annotation file
            track_id: Unique track identifier (defaults to filename)
            source: Data source ("local", "m_djcue", "beat_this")
            
        Returns:
            Track object with all features populated
        """
        audio_path = Path(audio_path)
        if track_id is None:
            track_id = audio_path.stem
        
        # Create progress bar for extraction steps
        steps = ['Load Audio', 'Rhythmic Grid', 'Annotations', 'Energy', 'Rhythm', 'Harmonic', 'Structural', 'Vocal', 'Key Detection']
        pbar = tqdm(total=len(steps), desc=f"Extracting {track_id[:30]}", leave=False, unit="step")
        
        # Load audio
        pbar.set_postfix_str("Loading audio...")
        y, sr = librosa.load(audio_path, sr=self.sr, mono=True)
        duration = librosa.get_duration(y=y, sr=sr)
        pbar.update(1)
        
        # Extract rhythmic grid (beats, bars, tempo)
        pbar.set_postfix_str("Beat tracking...")
        tempo, beats, bars = self._extract_rhythmic_grid(y, sr)
        num_bars = len(bars)
        pbar.update(1)
        
        # Extract sections from annotations or estimate
        sections = {}
        cue_in = np.array([])
        cue_out = np.array([])
        
        pbar.set_postfix_str("Loading annotations...")
        if annotation_path is not None:
            sections, cue_in, cue_out = self._load_annotations(annotation_path, bars)
        else:
            sections = self._estimate_sections(y, sr, bars)
        pbar.update(1)
        
        # Compute HPSS once (used by rhythm, harmonic, and vocal features)
        pbar.set_postfix_str("HPSS separation...")
        y_harmonic, y_percussive = librosa.effects.hpss(y)
        
        # Compute STFT once for efficiency (used by energy and vocal features)
        D = librosa.stft(y, n_fft=self.n_fft, hop_length=self.hop_length)
        S = np.abs(D) ** 2  # Power spectrogram
        
        # Extract bar-level features
        pbar.set_postfix_str("Energy features...")
        energy_features = self._extract_energy_features(y, sr, bars, S)
        pbar.update(1)
        
        pbar.set_postfix_str("Rhythm features...")
        rhythm_features = self._extract_rhythm_features(y, sr, bars, beats, y_percussive)
        pbar.update(1)
        
        pbar.set_postfix_str("Harmonic features...")
        harmonic_features = self._extract_harmonic_features(y, sr, bars, y_harmonic, y_percussive)
        pbar.update(1)
        
        pbar.set_postfix_str("Structural features...")
        structural_features = self._extract_structural_features(bars, sections)
        pbar.update(1)
        
        pbar.set_postfix_str("Vocal features...")
        vocal_features = self._extract_vocal_features(y, sr, bars, y_harmonic, S)
        pbar.update(1)
        
        pbar.set_postfix_str("Key detection...")
        key_tonic, key_scale, key_confidence = self._detect_key(y, sr)
        pbar.update(1)
        
        pbar.set_postfix_str("Complete!")
        pbar.close()
        
        # Construct Track object
        track = Track(
            # Metadata
            track_id=track_id,
            source=source,
            audio_path=audio_path,
            duration=duration,
            
            # Rhythmic Grid
            tempo=tempo,
            beats=beats,
            bars=bars,
            
            # Structural Labels
            sections=sections,
            
            # Content Features
            energy_per_bar=energy_features['energy_per_bar'],
            low_band_energy=energy_features['low_band_energy'],
            vocal_mask=vocal_features['vocal_mask'],
            
            # Enhanced Energy Features
            energy_derivative=energy_features['energy_derivative'],
            energy_volatility=energy_features['energy_volatility'],
            high_band_energy=energy_features['high_band_energy'],
            mid_band_energy=energy_features['mid_band_energy'],
            rms_energy=energy_features['rms_energy'],
            
            # Beat & Rhythm Quality
            beat_strength=rhythm_features['beat_strength'],
            beat_consistency=rhythm_features['beat_consistency'],
            syncopation=rhythm_features['syncopation'],
            percussion_intensity=rhythm_features['percussion_intensity'],
            
            # Harmonic & Timbral Features
            spectral_centroid=harmonic_features['spectral_centroid'],
            spectral_flatness=harmonic_features['spectral_flatness'],
            spectral_rolloff=harmonic_features['spectral_rolloff'],
            harmonic_ratio=harmonic_features['harmonic_ratio'],
            chroma_vector=harmonic_features['chroma_vector'],
            
            # Structural & Positional Features
            bar_position_normalized=structural_features['bar_position_normalized'],
            distance_to_section_boundary=structural_features['distance_to_section_boundary'],
            is_section_start=structural_features['is_section_start'],
            phrase_position=structural_features['phrase_position'],
            
            # Vocal & Melodic Activity
            vocal_activity_confidence=vocal_features['vocal_activity_confidence'],
            melodic_complexity=harmonic_features['melodic_complexity'],
            vocal_onset_likelihood=vocal_features['vocal_onset_likelihood'],
            
            # Harmonic Key
            key_tonic=key_tonic,
            key_scale=key_scale,
            key_confidence=key_confidence,
            
            # Training Labels
            cue_in=cue_in,
            cue_out=cue_out
        )
        
        return track
    
    # RHYTHMIC GRID EXTRACTION
    # ========================================================================
    
    def _extract_rhythmic_grid(self, y: np.ndarray, sr: int) -> Tuple[float, np.ndarray, np.ndarray]:
        """
        Extract tempo, beats, and bars from audio.
        
        Returns:
            (tempo, beats, bars) where beats and bars are in seconds
        """
        # Estimate tempo and beat frames
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=self.hop_length)
        
        # Convert frames to time
        beats = librosa.frames_to_time(beat_frames, sr=sr, hop_length=self.hop_length)
        
        # Assuming 4/4 time signature, create bars every 8 beats (2-bar phrases)
        # This matches the Track class specification
        bars = beats[::8]
        
        # Ensure at least one bar exists
        if len(bars) == 0:
            bars = np.array([0.0])
        
        return float(tempo), beats, bars
    
    # ANNOTATION LOADING
    # ========================================================================
    
    def _load_annotations(
        self,
        annotation_path: Path | str,
        bars: np.ndarray
    ) -> Tuple[dict, np.ndarray, np.ndarray]:
        """
        Load structural sections and cue points from JAMS file.
        
        Returns:
            (sections_dict, cue_in_array, cue_out_array)
        """
        annotation_path = Path(annotation_path)
        
        if not annotation_path.exists():
            print(f"  WARNING: Annotation file not found: {annotation_path}")
            return {}, np.array([]), np.array([])
        
        with open(annotation_path, 'r') as f:
            jams_data = json.load(f)
        
        sections = {}
        cue_in_times = []
        cue_out_times = []
        
        for annotation in jams_data.get('annotations', []):
            namespace = annotation.get('namespace', '')
            
            # Extract structural sections
            if namespace == 'segment_open':
                for segment in annotation.get('data', []):
                    time = segment.get('time', 0)
                    label = segment.get('value', '')
                    
                    # Find nearest bar index
                    bar_idx = self._time_to_bar_index(time, bars)
                    sections[bar_idx] = label
            
            # Extract cue points
            elif namespace == 'cue_point':
                for point in annotation.get('data', []):
                    time = point.get('time', 0)
                    label = point.get('value', {}).get('label', '')
                    
                    if time > 0:  # Only count nonzero times
                        if label == 'IN':
                            cue_in_times.append(time)
                        elif label == 'OUT':
                            cue_out_times.append(time)
        
        return sections, np.array(cue_in_times), np.array(cue_out_times)
    
    def _estimate_sections(self, y: np.ndarray, sr: int, bars: np.ndarray) -> dict[int, str]:
        """
        Estimate structural sections if no annotations available.
        Uses simple heuristics based on position and energy.
        """
        num_bars = len(bars)
        sections = {}
        
        if num_bars < 4:
            sections[0] = "Main"
            return sections
        
        # Simple heuristic: Intro (first 10%), Outro (last 10%), Main otherwise
        intro_bars = int(num_bars * 0.1)
        outro_start = int(num_bars * 0.9)
        
        sections[0] = "Intro"
        if intro_bars > 0 and intro_bars < num_bars:
            sections[intro_bars] = "Main"
        if outro_start < num_bars:
            sections[outro_start] = "Outro"
        
        return sections
    
    def _time_to_bar_index(self, time: float, bars: np.ndarray) -> int:
        """Find nearest bar index for a given time in seconds."""
        if len(bars) == 0:
            return 0
        return int(np.argmin(np.abs(bars - time)))
    
    # ENERGY FEATURES
    # ========================================================================
    
    def _extract_energy_features(self, y: np.ndarray, sr: int, bars: np.ndarray, S: np.ndarray) -> dict:
        """Extract all energy-related features per bar."""
        num_bars = len(bars)
        
        # S (power spectrogram) is already computed in extract()
        # Frequency bins for band separation
        freqs = librosa.fft_frequencies(sr=sr, n_fft=self.n_fft)
        low_idx = np.where(freqs < 250)[0][-1] if np.any(freqs < 250) else 10
        mid_start_idx = low_idx
        mid_end_idx = np.where(freqs < 4000)[0][-1] if np.any(freqs < 4000) else len(freqs) // 2
        high_idx = mid_end_idx
        
        # Initialize arrays
        energy_per_bar = np.zeros(num_bars)
        low_band_energy = np.zeros(num_bars)
        mid_band_energy = np.zeros(num_bars)
        high_band_energy = np.zeros(num_bars)
        rms_energy = np.zeros(num_bars)
        
        # Extract per-bar energy
        for i in range(num_bars):
            start_time = bars[i]
            end_time = bars[i + 1] if i + 1 < num_bars else len(y) / sr
            
            start_frame = librosa.time_to_frames(start_time, sr=sr, hop_length=self.hop_length)
            end_frame = librosa.time_to_frames(end_time, sr=sr, hop_length=self.hop_length)
            
            if start_frame >= S.shape[1]:
                continue
            end_frame = min(end_frame, S.shape[1])
            
            # Extract bar spectrogram
            bar_S = S[:, start_frame:end_frame]
            
            if bar_S.size == 0:
                continue
            
            # Total energy
            energy_per_bar[i] = np.mean(np.sum(bar_S, axis=0))
            
            # Band-specific energy
            low_band_energy[i] = np.mean(np.sum(bar_S[:low_idx, :], axis=0))
            mid_band_energy[i] = np.mean(np.sum(bar_S[mid_start_idx:mid_end_idx, :], axis=0))
            high_band_energy[i] = np.mean(np.sum(bar_S[high_idx:, :], axis=0))
            
            # RMS energy
            start_sample = int(start_time * sr)
            end_sample = int(end_time * sr)
            bar_audio = y[start_sample:end_sample]
            if len(bar_audio) > 0:
                rms_energy[i] = np.sqrt(np.mean(bar_audio ** 2))
        
        # Derived features
        energy_derivative = np.diff(energy_per_bar, prepend=energy_per_bar[0])
        
        # Energy volatility (rolling standard deviation with window of 4 bars)
        window = 4
        energy_volatility = np.zeros(num_bars)
        for i in range(num_bars):
            start = max(0, i - window // 2)
            end = min(num_bars, i + window // 2 + 1)
            energy_volatility[i] = np.std(energy_per_bar[start:end])
        
        return {
            'energy_per_bar': energy_per_bar,
            'low_band_energy': low_band_energy,
            'mid_band_energy': mid_band_energy,
            'high_band_energy': high_band_energy,
            'rms_energy': rms_energy,
            'energy_derivative': energy_derivative,
            'energy_volatility': energy_volatility
        }
    

    # RHYTHM FEATURES
    # ========================================================================
    
    def _extract_rhythm_features(
        self,
        y: np.ndarray,
        sr: int,
        bars: np.ndarray,
        beats: np.ndarray,
        y_percussive: np.ndarray
    ) -> dict:
        """Extract beat and rhythm quality features per bar."""
        num_bars = len(bars)
        
        # Compute onset strength envelope
        onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=self.hop_length)
        
        # y_percussive is already computed in extract()
        # Initialize arrays
        beat_strength = np.zeros(num_bars)
        beat_consistency = np.zeros(num_bars)
        syncopation = np.zeros(num_bars)
        percussion_intensity = np.zeros(num_bars)
        
        for i in range(num_bars):
            start_time = bars[i]
            end_time = bars[i + 1] if i + 1 < num_bars else len(y) / sr
            
            start_frame = librosa.time_to_frames(start_time, sr=sr, hop_length=self.hop_length)
            end_frame = librosa.time_to_frames(end_time, sr=sr, hop_length=self.hop_length)
            end_frame = min(end_frame, len(onset_env))
            
            if start_frame >= len(onset_env):
                continue
            
            # Beat strength: average onset strength in this bar
            bar_onset = onset_env[start_frame:end_frame]
            if len(bar_onset) > 0:
                beat_strength[i] = np.mean(bar_onset)
            
            # Beat consistency: autocorrelation of low-band energy (bass/kick regularity)
            start_sample = int(start_time * sr)
            end_sample = int(end_time * sr)
            bar_audio = y[start_sample:end_sample]
            
            if len(bar_audio) > sr // 2:  # At least 0.5s
                # FFT-based autocorrelation (much faster than np.correlate)
                bar_fft = fft.fft(bar_audio, n=2*len(bar_audio))
                autocorr = fft.ifft(bar_fft * np.conj(bar_fft)).real
                autocorr = autocorr[:len(bar_audio)]  # Keep positive lags
                
                # Peak at expected beat period indicates consistency
                expected_beat_samples = int(sr * 60 / 120)  # Assume ~120 BPM house music
                if len(autocorr) > expected_beat_samples * 2:
                    # Look for peak around beat period
                    search_range = autocorr[expected_beat_samples // 2:expected_beat_samples * 2]
                    if len(search_range) > 0:
                        beat_consistency[i] = np.max(search_range) / (np.std(autocorr) + 1e-6)
            
            # Syncopation: measure of off-beat emphasis
            # Higher entropy in onset timing = more syncopation
            if len(bar_onset) > 4:
                # Quantize onset strength to 16th notes
                n_subdivisions = 16
                subdivision_energy = np.array_split(bar_onset, n_subdivisions)
                subdivision_sums = np.array([np.sum(sub) for sub in subdivision_energy])
                subdivision_sums = subdivision_sums / (np.sum(subdivision_sums) + 1e-6)
                syncopation[i] = entropy(subdivision_sums + 1e-6)
            
            # Percussion intensity: RMS of percussive component
            bar_perc = y_percussive[start_sample:end_sample]
            if len(bar_perc) > 0:
                percussion_intensity[i] = np.sqrt(np.mean(bar_perc ** 2))
        
        return {
            'beat_strength': beat_strength,
            'beat_consistency': beat_consistency,
            'syncopation': syncopation,
            'percussion_intensity': percussion_intensity
        }
    
    # ========================================================================
    # HARMONIC & TIMBRAL FEATURES
    # ========================================================================
    
    def _extract_harmonic_features(self, y: np.ndarray, sr: int, bars: np.ndarray, y_harmonic: np.ndarray, y_percussive: np.ndarray) -> dict:
        """Extract harmonic and timbral features per bar."""
        num_bars = len(bars)
        
        # y_harmonic and y_percussive are already computed in extract()
        # Initialize arrays
        spectral_centroid = np.zeros(num_bars)
        spectral_flatness = np.zeros(num_bars)
        spectral_rolloff = np.zeros(num_bars)
        harmonic_ratio = np.zeros(num_bars)
        chroma_vector = np.zeros((num_bars, 12))
        melodic_complexity = np.zeros(num_bars)
        
        for i in range(num_bars):
            start_time = bars[i]
            end_time = bars[i + 1] if i + 1 < num_bars else len(y) / sr
            
            start_sample = int(start_time * sr)
            end_sample = int(end_time * sr)
            bar_audio = y[start_sample:end_sample]
            bar_harmonic = y_harmonic[start_sample:end_sample]
            bar_percussive = y_percussive[start_sample:end_sample]
            
            if len(bar_audio) < self.hop_length:
                continue
            
            # Spectral features
            cent = librosa.feature.spectral_centroid(y=bar_audio, sr=sr, hop_length=self.hop_length)
            spectral_centroid[i] = np.mean(cent)
            
            flat = librosa.feature.spectral_flatness(y=bar_audio, hop_length=self.hop_length)
            spectral_flatness[i] = np.mean(flat)
            
            rolloff = librosa.feature.spectral_rolloff(y=bar_audio, sr=sr, hop_length=self.hop_length)
            spectral_rolloff[i] = np.mean(rolloff)
            
            # Harmonic ratio: ratio of harmonic to percussive energy
            harmonic_energy = np.sum(bar_harmonic ** 2)
            percussive_energy = np.sum(bar_percussive ** 2)
            total_energy = harmonic_energy + percussive_energy
            if total_energy > 0:
                harmonic_ratio[i] = harmonic_energy / total_energy
            
            # Chroma vector (pitch class distribution)
            chroma = librosa.feature.chroma_stft(y=bar_audio, sr=sr, hop_length=self.hop_length)
            chroma_vector[i] = np.mean(chroma, axis=1)
            
            # Melodic complexity: number of statistically prominent pitch classes
            # Uses mean + 0.5*std to find peaks above the noise floor
            # Lower values (2-4) = simple melody, higher (7-10) = complex harmony
            chroma_mean = chroma_vector[i]
            mean_val = np.mean(chroma_mean)
            std_val = np.std(chroma_mean)
            threshold = mean_val + 0.5 * std_val
            melodic_complexity[i] = np.sum(chroma_mean > threshold)
        
        return {
            'spectral_centroid': spectral_centroid,
            'spectral_flatness': spectral_flatness,
            'spectral_rolloff': spectral_rolloff,
            'harmonic_ratio': harmonic_ratio,
            'chroma_vector': chroma_vector,
            'melodic_complexity': melodic_complexity
        }
    
    # ========================================================================
    # STRUCTURAL FEATURES
    # ========================================================================
    
    def _extract_structural_features(self, bars: np.ndarray, sections: dict[int, str]) -> dict:
        """Extract structural and positional features per bar."""
        num_bars = len(bars)
        
        # Bar position normalized
        bar_position_normalized = np.arange(num_bars) / max(num_bars - 1, 1)
        
        # Section boundaries
        section_boundaries = sorted(sections.keys())
        
        # Distance to next section boundary
        distance_to_section_boundary = np.zeros(num_bars)
        is_section_start = np.zeros(num_bars, dtype=bool)
        
        for i in range(num_bars):
            # Mark section starts
            if i in section_boundaries:
                is_section_start[i] = True
            
            # Find distance to next boundary
            future_boundaries = [b for b in section_boundaries if b > i]
            if future_boundaries:
                distance_to_section_boundary[i] = future_boundaries[0] - i
            else:
                distance_to_section_boundary[i] = num_bars - i
        
        # Phrase position (within 16-bar phrases)
        phrase_position = np.arange(num_bars) % 16
        
        return {
            'bar_position_normalized': bar_position_normalized,
            'distance_to_section_boundary': distance_to_section_boundary,
            'is_section_start': is_section_start,
            'phrase_position': phrase_position
        }
    
    # ========================================================================
    # VOCAL FEATURES
    # ========================================================================
    
    def _extract_vocal_features(self, y: np.ndarray, sr: int, bars: np.ndarray, y_harmonic: np.ndarray, S_power: np.ndarray) -> dict:
        """
        Extract vocal-related features per bar.
        
        Note: Full vocal separation (Demucs/Spleeter) is computationally expensive.
        This uses a heuristic based on mid-frequency energy and harmonic content.
        For production, consider running vocal separation as a separate preprocessing step.
        """
        num_bars = len(bars)
        
        vocal_mask = np.zeros(num_bars, dtype=bool)
        vocal_activity_confidence = np.zeros(num_bars)
        vocal_onset_likelihood = np.zeros(num_bars)
        
        if self.enable_vocal_separation:
            # TODO: Integrate Demucs or Spleeter for actual vocal separation
            # This is a placeholder for when you enable vocal separation
            print("  NOTE: Full vocal separation not yet implemented. Using heuristic.")
        
        # y_harmonic and S_power are already computed in extract()
        # Compute spectrogram of harmonic component once
        D_harmonic = librosa.stft(y_harmonic, n_fft=self.n_fft, hop_length=self.hop_length)
        S_harmonic = np.abs(D_harmonic)
        
        # Frequency bins for vocal range
        freqs = librosa.fft_frequencies(sr=sr, n_fft=self.n_fft)
        vocal_range_idx = np.where((freqs >= 200) & (freqs <= 3000))[0]
        
        for i in range(num_bars):
            start_time = bars[i]
            end_time = bars[i + 1] if i + 1 < num_bars else len(y_harmonic) / sr
            
            start_frame = librosa.time_to_frames(start_time, sr=sr, hop_length=self.hop_length)
            end_frame = librosa.time_to_frames(end_time, sr=sr, hop_length=self.hop_length)
            end_frame = min(end_frame, S_harmonic.shape[1])
            
            if start_frame >= S_harmonic.shape[1]:
                continue
            
            # Slice precomputed spectrogram for this bar
            S_bar = S_harmonic[:, start_frame:end_frame]
            
            if S_bar.size == 0:
                continue
            
            # Vocal frequency range energy
            if len(vocal_range_idx) > 0:
                vocal_range_energy = np.mean(np.sum(S_bar[vocal_range_idx, :], axis=0))
                total_energy = np.mean(np.sum(S_bar, axis=0))
                
                if total_energy > 0:
                    vocal_activity_confidence[i] = vocal_range_energy / total_energy
                    
                    # Simple threshold for binary mask
                    if vocal_activity_confidence[i] > 0.3:
                        vocal_mask[i] = True
        
        # Vocal onset likelihood: look ahead 4 bars for increasing vocal activity
        for i in range(num_bars):
            if i + 4 < num_bars:
                future_vocal_activity = vocal_activity_confidence[i+1:i+5]
                current_activity = vocal_activity_confidence[i]
                if len(future_vocal_activity) > 0:
                    # Likelihood based on whether vocals increase in next bars
                    vocal_onset_likelihood[i] = max(0, np.mean(future_vocal_activity) - current_activity)
        
        return {
            'vocal_mask': vocal_mask,
            'vocal_activity_confidence': vocal_activity_confidence,
            'vocal_onset_likelihood': vocal_onset_likelihood
        }
    
    # ========================================================================
    # KEY DETECTION
    # ========================================================================
    
    def _detect_key(self, y: np.ndarray, sr: int) -> Tuple[int, str, float]:
        """
        Detect musical key using chroma features and template matching.
        
        Returns:
            (key_tonic, key_scale, key_confidence)
            key_tonic: 0-11 (C to B)
            key_scale: "minor" or "major"
            key_confidence: 0.0-1.0
        """
        # Compute chroma features
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        
        # Average chroma over time
        chroma_mean = np.mean(chroma, axis=1)
        
        # Krumhansl-Schmuckler key profiles
        major_profile = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
        minor_profile = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
        
        # Normalize profiles
        major_profile /= np.sum(major_profile)
        minor_profile /= np.sum(minor_profile)
        chroma_mean /= (np.sum(chroma_mean) + 1e-6)
        
        # Try all 12 transpositions for major and minor
        best_correlation = -1
        best_tonic = 0
        best_scale = "major"
        
        for tonic in range(12):
            # Rotate chroma to this tonic
            rotated_chroma = np.roll(chroma_mean, -tonic)
            
            # Correlate with major profile
            major_corr = np.corrcoef(rotated_chroma, major_profile)[0, 1]
            if major_corr > best_correlation:
                best_correlation = major_corr
                best_tonic = tonic
                best_scale = "major"
            
            # Correlate with minor profile
            minor_corr = np.corrcoef(rotated_chroma, minor_profile)[0, 1]
            if minor_corr > best_correlation:
                best_correlation = minor_corr
                best_tonic = tonic
                best_scale = "minor"
        
        # Convert correlation to confidence (0-1 range)
        key_confidence = max(0, min(1, (best_correlation + 1) / 2))
        
        return best_tonic, best_scale, key_confidence


# ============================================================================
# BATCH PROCESSING UTILITIES
# ============================================================================

def process_dataset(
    audio_dir: Path | str,
    annotation_dir: Optional[Path | str] = None,
    output_dir: Optional[Path | str] = None,
    file_pattern: str = "*.mp3",
    source: str = "local"
) -> list[Track]:
    """
    Batch process a directory of audio files.
    
    Args:
        audio_dir: Directory containing MP3 files
        annotation_dir: Optional directory with matching JAMS files
        output_dir: Optional directory to save serialized Track objects
        file_pattern: Glob pattern for audio files
        source: Data source identifier
        
    Returns:
        List of Track objects
    """
    audio_dir = Path(audio_dir)
    audio_files = sorted(audio_dir.glob(file_pattern))
    
    print(f"[BatchProcessor] Found {len(audio_files)} audio files in {audio_dir}\n")
    
    extractor = Extractor()
    tracks = []
    
    # Progress bar for batch processing
    for audio_file in tqdm(audio_files, desc="Processing tracks", unit="track"):
        # Find matching annotation file
        annotation_file = None
        if annotation_dir is not None:
            annotation_dir = Path(annotation_dir)
            potential_annotation = annotation_dir / f"{audio_file.stem}.jams"
            if potential_annotation.exists():
                annotation_file = potential_annotation
        
        try:
            track = extractor.extract(
                audio_path=audio_file,
                annotation_path=annotation_file,
                track_id=audio_file.stem,
                source=source
            )
            tracks.append(track)
            
            # Optionally save to disk
            if output_dir is not None:
                output_dir = Path(output_dir)
                output_dir.mkdir(parents=True, exist_ok=True)
                output_file = output_dir / f"{audio_file.stem}.pkl"
                import pickle
                with open(output_file, 'wb') as f:
                    pickle.dump(track, f)
        
        except Exception as e:
            tqdm.write(f"  ERROR processing {audio_file.name}: {e}")
            continue
    
    print(f"\n[BatchProcessor] Successfully processed {len(tracks)}/{len(audio_files)} tracks")
    return tracks
