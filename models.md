# BeatBot: Machine Learning Pipeline & Model Selection

## Executive Summary

BeatBot frames DJ cue point detection as a **bar-level ranking problem**. Given ~2000 annotated cue points and bar-level features extracted from audio, the goal is to predict the top 3 entry and exit points per track. This document outlines three modeling approaches, recommended features, and a complete ML pipeline.

---

## 1. Problem Formulation

### Input

- **Raw Audio**: MP3 files (unseen tracks)
- **Preprocessing Output**: `Track` object with bar-level features (shape: `[num_bars, num_features]`)

### Output

- **Top 3 Entry Cues**: Bar indices ranked by suitability as mix-in points
- **Top 3 Exit Cues**: Bar indices ranked by suitability as mix-out points

### Training Paradigm

- **Learning-to-Rank**: Each bar is a candidate; model assigns a score; top-K candidates are selected
- **Separate Models**: Train independent models for IN and OUT cues (different musical criteria)

---

## 2. Modeling Approaches

### Approach 1: LightGBM (Gradient Boosted Decision Trees) ⭐ **RECOMMENDED**

#### Why This Works Best for Your Use Case

**Strengths:**

- **Data Efficiency**: Excels with ~2000 samples, unlike neural networks that need 10K+
- **Feature Engineering Power**: Leverages your domain knowledge about house music structure
- **Built-in Ranking Objective**: Native LambdaRank support optimizes for ranking metrics (NDCG)
- **Fast Iteration**: Train in seconds, enabling rapid experimentation
- **Interpretability**: Feature importance reveals what makes a good cue point (e.g., "energy spike", "vocal absence")
- **Robust**: Handles missing features gracefully (e.g., if key detection fails)

**Architecture:**

```
Input: Bar-level feature vector [~50-100 features]
       ↓
LightGBM Ranker (1000-3000 trees, depth 6-8)
       ↓
Score per bar [0.0 - 1.0]
       ↓
Top-3 Selection (argsort)
```

**Training Setup:**

- **Objective**: `lambdarank` (optimizes for NDCG@3)
- **Group by**: Track ID (each track is a ranking problem)
- **Label**: Binary (1 = annotated cue, 0 = non-cue) or soft labels with tolerance
- **Validation**: 5-fold cross-validation by track (avoid data leakage)

**Hyperparameters to Tune:**

- `num_leaves`: 31-127 (controls model complexity)
- `learning_rate`: 0.01-0.1
- `min_data_in_leaf`: 20-100 (prevent overfitting with small dataset)
- `feature_fraction`: 0.7-0.9 (column subsampling)

**Expected Performance:**

- With 2000 cues: Strong performance if features capture musicality
- Baseline: NDCG@3 ≈ 0.65-0.75 (depends on annotation consistency)
- With feature engineering: NDCG@3 ≈ 0.75-0.85

---

### Approach 2: Neural Networks (Feature-Based or End-to-End)

#### Option 2A: Temporal Convolutional Network (TCN) + Attention

**When to Use**: If you expand to 5K+ cue points or want to learn latent structure.

**Architecture:**

```
Input: Bar-level features [num_bars, num_features]
       ↓
Temporal Conv Layers (kernel=3, dilated) [learn local patterns]
       ↓
Self-Attention Layer [capture long-range dependencies]
       ↓
Point-wise Feed-Forward [per-bar scoring]
       ↓
Sigmoid Activation → [num_bars, 1]
       ↓
Top-3 Selection
```

**Strengths:**

- Captures **temporal patterns** (e.g., "build → drop" sequences)
- Learns context around each bar (e.g., "exit cues rarely happen before bar 16")

**Weaknesses:**

- **Data Hungry**: 2000 samples is borderline; needs heavy regularization (dropout 0.3-0.5)
- Slower to train and tune than LightGBM
- Harder to debug (black box)

**Loss Function:**

- Binary Cross-Entropy with **class weights** (positive cues are rare)
- Or **Pairwise Ranking Loss**: Margin loss between positive and negative bars

---

#### Option 2B: End-to-End CNN on Mel-Spectrograms (Advanced)

**Architecture:**

```
Input: Mel-spectrogram (80 bins × time frames)
       ↓
2D CNN Encoder (ResNet-18 backbone)
       ↓
Temporal Pooling (aggregate to bar-level)
       ↓
LSTM/Transformer (model bar sequences)
       ↓
Per-bar classification head
```

**Strengths:**

- Minimal feature engineering (learns from raw spectrograms)
- Can discover subtle audio patterns humans miss

**Weaknesses:**

- **Severely Data-Limited**: Needs 10K+ tracks for stable training
- Computationally expensive (GPU required)
- Loses interpretability
- **Not Recommended** for your current dataset size

---

### Approach 3: Hybrid (Feature Engineering + Shallow NN)

**Best of Both Worlds:**

1. Extract rich features (LightGBM-style)
2. Use a small neural network (2-3 layers, 128-256 units) to learn non-linear combinations
3. Apply bar-wise features + **contextual features** (sliding window of ±4 bars)

**Architecture:**

```
Input: [bar_features + context_window_features]
       ↓
Dense(256) + ReLU + Dropout(0.3)
       ↓
Dense(128) + ReLU + Dropout(0.3)
       ↓
Dense(1) + Sigmoid
```

**When to Use**:

- If LightGBM plateaus and you suspect non-linear interactions
- Still trainable with 2000 samples using aggressive augmentation

---

## 3. Recommended Additional Features for Track Class

### Critical Missing Features (High Priority)

#### A. Energy & Dynamics

```python
energy_derivative: np.ndarray  # shape (M,), ΔE between bars (detects builds/drops)
energy_volatility: np.ndarray  # shape (M,), Rolling std of energy (stability measure)
high_band_energy: np.ndarray   # shape (M,), >4kHz energy (hi-hats, cymbals)
mid_band_energy: np.ndarray    # shape (M,), 250-4kHz (melodic content)
rms_energy: np.ndarray         # shape (M,), Root-mean-square energy per bar
```

**Why**:

- Entry cues often coincide with **energy increases** or **stable energy regions**
- Exit cues often occur at **energy drops** or **before vocal sections**

---

#### B. Beat & Rhythm Quality

```python
beat_strength: np.ndarray      # shape (M,), Average onset strength per bar
beat_consistency: np.ndarray   # shape (M,), Regularity of kick drum pattern
syncopation: np.ndarray        # shape (M,), Off-beat emphasis (0=straight, 1=syncopated)
percussion_intensity: np.ndarray  # shape (M,), Isolated percussion loudness
```

**Why**:

- DJs prefer mixing during **strong, consistent beats** (easy to beatmatch)
- Syncopated sections are harder to mix into

**Extraction**:

- Use `librosa.onset.onset_strength()` for beat_strength
- Autocorrelation of low_band_energy for beat_consistency

---

#### C. Harmonic & Timbral Features

```python
spectral_centroid: np.ndarray  # shape (M,), Brightness of sound
spectral_flatness: np.ndarray  # shape (M,), Noisiness (0=tonal, 1=noisy)
spectral_rolloff: np.ndarray   # shape (M,), Frequency below which 85% energy lies
harmonic_ratio: np.ndarray     # shape (M,), Harmonic vs percussive balance
chroma_vector: np.ndarray      # shape (M, 12), Pitch class distribution per bar
```

**Why**:

- Tonal stability matters for harmonic mixing
- Spectral changes signal transitions (e.g., filter sweeps before drops)

---

#### D. Structural & Positional Features

```python
bar_position_normalized: np.ndarray  # shape (M,), Bar index / total_bars (0.0 - 1.0)
distance_to_section_boundary: np.ndarray  # shape (M,), Bars until next section change
is_section_start: np.ndarray  # shape (M,), Boolean flag
phrase_position: np.ndarray   # shape (M,), Position within 16-bar phrase (0-15)
```

**Why**:

- Entry cues rarely happen in first 10% of track (intro too sparse)
- Exit cues rarely happen in last 10% (outro already mixing out)
- Section boundaries (Intro→Build, Drop→Break) are natural cue points

---

#### E. Vocal & Melodic Activity

```python
vocal_activity_confidence: np.ndarray  # shape (M,), 0.0-1.0 from source separation
melodic_complexity: np.ndarray  # shape (M,), Number of active harmonic peaks
vocal_onset_likelihood: np.ndarray  # shape (M,), Predicts if vocals start in next 4 bars
```

**Why**:

- **Entry cues**: Prefer instrumental sections (easier to mix into)
- **Exit cues**: Avoid starting vocal phrases (sounds jarring if cut off)

**Extraction**:

- Use `demucs` or `spleeter` for vocal separation
- Compute RMS energy on vocal track per bar

---

#### F. Transition Suitability (Derived Features)

```python
entry_signal: np.ndarray       # shape (M,), Heuristic score based on musical rules
exit_signal: np.ndarray        # shape (M,), Heuristic score based on musical rules
is_intro_or_outro: np.ndarray  # shape (M,), Boolean from sections dict
local_energy_peak: np.ndarray  # shape (M,), Boolean if bar is local max energy
energy_plateau: np.ndarray     # shape (M,), Boolean if energy stable for 4+ bars
```

**Why**: These are **feature engineering based on DJ heuristics**—they can bootstrap learning:

- Entry signal: High if (strong beat + no vocals + mid-track + stable energy)
- Exit signal: High if (energy drop + end of phrase + before breakdown)

---

### Feature Extraction Pipeline (Pseudocode)

```python
def extract_features(audio_path: Path) -> Track:
    # Load audio
    y, sr = librosa.load(audio_path, sr=44100)

    # Beat tracking
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
    bars = beats[::8]  # Assuming 4/4 time, 2-bar phrases

    # Spectral features (per bar)
    for bar_idx, (start, end) in enumerate(zip(bars[:-1], bars[1:])):
        bar_audio = y[int(start*sr):int(end*sr)]

        # Energy bands
        stft = librosa.stft(bar_audio)
        low_energy = np.sum(np.abs(stft[:50, :])**2)  # <250Hz
        mid_energy = np.sum(np.abs(stft[50:500, :])**2)
        high_energy = np.sum(np.abs(stft[500:, :])**2)

        # Spectral stats
        centroid = librosa.feature.spectral_centroid(y=bar_audio, sr=sr).mean()
        flatness = librosa.feature.spectral_flatness(y=bar_audio).mean()

        # Beat strength
        onset_env = librosa.onset.onset_strength(y=bar_audio, sr=sr)
        beat_strength = onset_env.mean()

        # Store in arrays...

    # Vocal separation (if available)
    vocals = separate_vocals(y)  # Using demucs/spleeter
    vocal_energy_per_bar = compute_rms_per_bar(vocals, bars)

    # Structural analysis
    sections = detect_sections(y, sr, bars)  # Clustering or manual

    return Track(
        # ... populate all fields
    )
```

---

## 4. Complete ML Pipeline

### Stage 1: Data Preprocessing (Batch)

```
MP3 Files → Feature Extraction → Track Objects → Serialized Dataset (HDF5/Pickle)
```

**Details:**

- Process all 2000 tracks once; cache features to disk
- Normalize features (StandardScaler or RobustScaler)
- Handle missing data (e.g., if key detection fails, impute with mode)

---

### Stage 2: Dataset Creation (for Training)

```
Track Objects → Bar-Level Feature Matrix + Labels
```

**Structure:**

- Each sample = one bar from one track
- Features: [~100-dim vector]
- Label: 1 if bar is an annotated cue (IN or OUT), 0 otherwise
- Metadata: Track ID (for grouping in LambdaRank)

**Class Imbalance:**

- Positive samples: ~2000 cue bars
- Negative samples: ~50,000-100,000 non-cue bars (assuming 50-100 bars/track × 2000 tracks)
- **Solution**: Use class weights or negative sampling (sample harder negatives near true cues)

---

### Stage 3: Model Training

#### For LightGBM (Recommended):

```python
import lightgbm as lgb

# Prepare data
train_data = lgb.Dataset(
    X_train,
    label=y_train,
    group=track_groups_train  # [num_bars_track1, num_bars_track2, ...]
)

# Train
params = {
    'objective': 'lambdarank',
    'metric': 'ndcg',
    'ndcg_eval_at': [1, 3, 5],
    'num_leaves': 63,
    'learning_rate': 0.05,
    'feature_fraction': 0.8,
    'min_data_in_leaf': 50
}

model = lgb.train(params, train_data, num_boost_round=1000, valid_sets=[val_data])
```

#### For Neural Network:

```python
import tensorflow as tf

model = tf.keras.Sequential([
    tf.keras.layers.Dense(256, activation='relu', input_dim=num_features),
    tf.keras.layers.Dropout(0.4),
    tf.keras.layers.Dense(128, activation='relu'),
    tf.keras.layers.Dropout(0.3),
    tf.keras.layers.Dense(1, activation='sigmoid')
])

model.compile(
    optimizer='adam',
    loss='binary_crossentropy',
    metrics=[tf.keras.metrics.AUC()]
)

# Class weighting
class_weight = {0: 1.0, 1: 50.0}  # Adjust based on imbalance

model.fit(X_train, y_train, class_weight=class_weight, epochs=50, validation_split=0.2)
```

---

### Stage 4: Inference (Unseen Track)

```
New MP3 → Feature Extraction → Track Object → Model Prediction
                                                        ↓
                                              Bar Scores [num_bars,]
                                                        ↓
                                              Top-3 Entry Indices
                                              Top-3 Exit Indices
```

**Post-processing:**

- Apply **minimum distance constraint**: Selected cues must be ≥8 bars apart (avoid redundancy)
- Filter by **section type**: Entry cues should avoid "Outro", exit cues avoid "Intro"

---

## 5. Evaluation Strategy

### Primary Metric: NDCG@3 (Normalized Discounted Cumulative Gain)

- Rewards ranking quality: Top prediction matters most
- With soft labels: Predictions near ground truth get partial credit

### Secondary Metrics:

- **Precision@K**: % of top-K predictions within tolerance window (±2 bars)
- **Recall with Tolerance**: % of ground-truth cues captured in top-10 predictions
- **Mean Reciprocal Rank (MRR)**: Average of 1/rank for first correct prediction

### Soft Evaluation Windows:

- ±1 bar: 100% credit
- ±2 bars: 75% credit
- ±4 bars (phrase boundary): 50% credit (structurally valid alternative)
- Further: 0% credit

---

## 6. Recommended Action Plan

### Phase 1: Baseline (Week 1-2)

1. **Add critical features** to Track class (priority: energy derivatives, beat strength, vocal mask refinement)
2. Implement feature extraction pipeline
3. Train **LightGBM baseline** with existing features
4. Establish evaluation framework with soft metrics

**Success Criteria**: NDCG@3 ≥ 0.65 on validation set

---

### Phase 2: Feature Engineering (Week 3-4)

1. Add all recommended features (spectral, harmonic, positional)
2. Feature ablation study: Which features matter most?
3. Engineer domain-specific "cue signals" (heuristic scores)
4. Tune LightGBM hyperparameters (Optuna or grid search)

**Success Criteria**: NDCG@3 ≥ 0.75

---

### Phase 3: Model Experimentation (Week 5-6)

1. Try hybrid NN approach (if LightGBM plateaus)
2. Experiment with ensemble: LightGBM + NN predictions averaged
3. Add data augmentation: Time-stretching (±5% tempo), pitch shifting (±1 semitone)
4. Collect 500-1000 more annotations if possible

**Success Criteria**: NDCG@3 ≥ 0.80

---

### Phase 4: Production Integration (Week 7+)

1. Implement real-time inference pipeline (latency <1 second per track)
2. Add confidence scores: Only show alternatives if score difference is small
3. Build UI for manual override (DJ can shift cue by ±4 bars)
4. Active learning loop: Log user corrections to retrain model

---

## 7. Final Recommendations

### Start With: **LightGBM + Rich Features**

**Rationale:**

- Your 2000-sample dataset is perfect for gradient boosting
- Feature engineering lets you inject DJ domain knowledge
- Fast iteration means you'll reach good performance quickly
- Interpretability helps debug mistakes (e.g., "model relies too heavily on energy, ignoring vocals")

### Upgrade If:

- You collect 5K+ cue points → Try neural networks
- You need to process spectrograms directly → Try CNN approach
- LightGBM maxes out at NDCG@3 = 0.75 → Try hybrid or ensemble

### Critical Success Factors:

1. **Vocal detection quality**: Bad vocal masks will hurt entry/exit predictions
2. **Beat tracking accuracy**: If bars are misaligned, all features are wrong
3. **Section labeling**: Manual or semi-automated? Quality matters for structural features
4. **Annotation consistency**: If you and other annotators disagree often, model will struggle

### Data Augmentation Ideas (If Needed):

- **Tempo variation**: Process tracks at ±5% speed (still valid house music)
- **Synthetic cues**: For tracks with 1 entry cue, add a "plausible" 2nd cue at phrase boundary
- **Cross-validation by BPM**: Ensure model generalizes across 120-128 BPM range

---

## 8. Expected Performance Benchmarks

| Model                    | Dataset Size | NDCG@3 (Expected) | Training Time | Interpretability |
| ------------------------ | ------------ | ----------------- | ------------- | ---------------- |
| LightGBM Baseline        | 2000 cues    | 0.65-0.70         | Minutes       | High ⭐⭐⭐⭐⭐  |
| LightGBM + Full Features | 2000 cues    | 0.75-0.82         | Minutes       | High ⭐⭐⭐⭐⭐  |
| Shallow NN (Hybrid)      | 2000 cues    | 0.70-0.78         | 10-30 min     | Medium ⭐⭐⭐    |
| TCN + Attention          | 5000+ cues   | 0.78-0.85         | 1-3 hours     | Low ⭐⭐         |
| End-to-End CNN           | 10000+ cues  | 0.80-0.88         | 5-10 hours    | Very Low ⭐      |

**Human Expert Consistency**: Even experienced DJs agree on "best" cue ~70-80% of the time, so NDCG@3 ≥ 0.80 is excellent.

---

## Conclusion

For BeatBot, **start with LightGBM using engineered features**. It's data-efficient, fast, and interpretable—critical for a domain where you understand the problem deeply. Invest heavily in feature engineering (especially energy dynamics, beat quality, and vocal detection). Neural networks are a future upgrade once you have 5K+ annotated tracks.

Your pipeline should be: **MP3 → librosa features → LightGBM → Top-3 cues**. Iterate on features until NDCG@3 ≥ 0.75, then decide if complexity is needed.
