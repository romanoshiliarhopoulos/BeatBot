# BeatBot Model Architecture

The `BeatBotModel` class (`src/model/lightgbm.py`) is the core engine for predicting DJ cue points. It uses a **Learning-to-Rank** approach powered by LightGBM to evaluate every bar of a song and assign a probability score for being a good **Entry Point** or **Exit Point**.

## 1. Core Architecture

### Dual Classifiers

Mixing requires two distinct decisions that rely on different musical cues:

1.  **Entry Points (`is_cue_in`)**: Where to _start_ the next track. Typically driven by structural beginnings (Intro, Verse 1 start) and clean beats.
2.  **Exit Points (`is_cue_out`)**: Where to _mix out_ of the current track. Driven by structural endings (Outro, Chorus end) or breakdown anticipation.

To handle this, `BeatBotModel` wraps **two separate LightGBM classifiers**:

- `self.entry_model`: Trained only on `is_cue_in` labels.
- `self.exit_model`: Trained only on `is_cue_out` labels.

### Feature Consistency

The model relies on the `FeatureExtractor` class (`src/features.py`) to ensure that training and inference always use the exact same feature engineering pipeline. This includes:

- **Key-Invariant Chroma**: Rotating harmonic features so they align to the track's Tonic (Root), making the model key-agnostic.
- **Rolling Context Windows**: Analyzing energy shifts over +/- 8 bars to detect drops and buildups.

## 2. Usage Guide

### Training

The training process automatically handles the class imbalance (since cue points are rare events, <1% of bars) by calculating `scale_pos_weight`.

```python
from src.track import Track
from src.model.lightgbm import BeatBotModel

# Load your tracks (must have cue_in/cue_out labels)
tracks = [Track(...), ...]

model = BeatBotModel()
model.train(tracks)
model.save("beatbot_v1.pkl")
```

### Prediction (Inference)

The primary output is a DataFrame containing probabilities for every bar.

```python
# Load model
model = BeatBotModel()
model.load("beatbot_v1.pkl")

# Predict
predictions = model.predict_track(new_track)
# Returns DataFrame with columns: ['bar_index', 'prob_in', 'prob_out']
```

## 3. Fulfilling Project Criteria

The architecture is specifically designed to meet the requirements defined in `README.md`:

### Goal A: "Choose an exit cue on current song and entry cue on next song"

- **Implementation**:
  - For the **Current Song**, we look at the `prob_out` column. The bar with the highest probability is the "Best Exit".
  - For the **Next Song**, we look at the `prob_in` column. The bar with the highest probability is the "Best Entry".

### Goal B: "Find best cue along with 2 alternatives"

- **Implementation**: Since the model outputs a probability _score_ for every single bar, finding alternatives is trivial. We simply sort the probabilities and pick the top N distinct local maxima.
  - _Example_: Calculate `peaks` in `prob_out` and return the top 3 indices.

### Goal C: "Trigger transition within next 10-15s"

- **Implementation**: The model predicts on the entire track timeline in advance. To find the optimal exit "right now":
  1.  Convert "10-15s" to bar indices (e.g., at 128 BPM, 15s is ~8 bars).
  2.  Slice the `prob_out` array for the window `[current_bar : current_bar + 8]`.
  3.  Find the `argmax` within that specific slice.
  - This returns the _local optimal_ exit point closest to the user's trigger action.

## 4. Why LightGBM?

We chose LightGBM over other classifiers because:

1.  **Speed**: Feature extraction and prediction for a full track takes milliseconds, enabling real-time analysis.
2.  **Handling NaNs**: It natively handles missing data (e.g., undefined pitch in silent sections).
3.  **Accuracy**: The Gradient Boosting approach captures complex non-linear interactions between **Structure** (`bar_pos_norm`) and **Energy Dynamics** (`energy_diff_context`) better than linear models.
