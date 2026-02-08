from dataclasses import dataclass, field
import numpy as np
from pathlib import Path

@dataclass
class Track:
    """
    Unified track representation for M-DJCUE, Beat This, and local audio. With from hand annotations.
    """

    # Metadata 
    track_id: str
    source: str             # "m_djcue"/ "beat_this" / "local"
    audio_path: Path | None
    duration: float         # Total track length in seconds

    
    # Rhythmic Grid 
    tempo: float
    beats: np.ndarray     # shape (N,), seconds
    bars: np.ndarray      # shape (M,), seconds - phrase boundaries (every 8 beats in 4/4)
    
    # Structural Labels  
    # Granular sections: "Intro", "Verse", "Build", "Drop", "Break", "Outro"
    sections: dict[int, str]  # {bar_idx: section_name}, ex: {0: "Intro", 8: "Build", 24: "Drop", 40: "Outro"}
    
    # Content Features
    energy_per_bar: np.ndarray | None = None # shape (M,), Global Energy
    low_band_energy: np.ndarray | None = None # shape (M,), <250Hz energy, Bass Energy (tracks Kick Drum)
    vocal_mask: np.ndarray | None = None # shape (M,), dtype=bool - True if vocals active in this bar

    # Harmonic Key (For Cameolot Mixing). Store as index (0-11 for C->B) and scale (0=minor, 1=major)
    key_tonic: int | None = None # 0-11
    key_scale: str | None = None # "minor" or "major"
    key_confidence: float | None = None # 0.0-1.0, confidence in key detection


    # Training Labels
    # Only populated for M-DJCUE data
    cue_in: np.ndarray = field(default_factory=lambda: np.array([]))
    cue_out: np.ndarray = field(default_factory=lambda: np.array([]))


    # DERIVED PROPERTIES 
    @property
    def num_bars(self) -> int:
        """Number of 2-bar phrases in track."""
        return len(self.bars)
    
    @property
    def has_cue_labels(self) -> bool:
        """True if this track has ground-truth cue points."""
        return len(self.cue_in) > 0 or len(self.cue_out) > 0
    
    @property
    def camelot_code(self) -> str | None:
        """Camelot wheel notation (e.g., '8A', '5B')."""
        if self.key_tonic is None or self.key_scale is None:
            return None
        
        # Camelot mapping for minor keys (inner wheel, 'A')
        camelot_minor = {0: '5A', 1: '12A', 2: '7A', 3: '2A', 4: '9A', 5: '4A',
                        6: '11A', 7: '6A', 8: '1A', 9: '8A', 10: '3A', 11: '10A'}
        
        # Camelot mapping for major keys (outer wheel, 'B')
        camelot_major = {0: '8B', 1: '3B', 2: '10B', 3: '5B', 4: '12B', 5: '7B',
                        6: '2B', 7: '9B', 8: '4B', 9: '11B', 10: '6B', 11: '1B'}
        
        mapping = camelot_minor if self.key_scale == 'minor' else camelot_major
        return mapping.get(self.key_tonic, None)
    
    def get_bar_index(self, time_sec: float) -> int:
        """Find nearest bar index for a given time."""
        if len(self.bars) == 0:
            return 0
        return int(np.argmin(np.abs(self.bars - time_sec)))
    
    def get_section_at_bar(self, bar_idx: int) -> str | None:
        """Get section type for a given bar index."""

        if len(self.section_boundaries) == 0:
            return None
        
        # Find the last boundary <= bar_idx
        valid_boundaries = self.section_boundaries[self.section_boundaries <= bar_idx]

        if len(valid_boundaries) == 0:
            return self.section_types[0] if self.section_types else None
        
        boundary_idx = len(valid_boundaries) - 1

        return self.section_types[boundary_idx] if boundary_idx < len(self.section_types) else None