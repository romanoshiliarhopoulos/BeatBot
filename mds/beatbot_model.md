# BeatBot Model Architecture

The `BeatBotModel` class (`src/model/lightgbm.py`) is the core engine for predicting DJ cue points. It uses a **Learning-to-Rank (LambdaRank)** approach powered by LightGBM to evaluate every bar of a song and rank them by their suitability as an **Entry Point** or **Exit Point**.

## 1. Core Architecture

### Learning-to-Rank (LambdaRank)

Unlike traditional binary classification (which asks "Is this a cue point?"), BeatBot uses **LambdaRank** with the **NDCG** (Normalized Discounted Cumulative Gain) metric.

- **Why?** In DJing, some points are "perfect" (Grade 2), while others are "acceptable" (Grade 1). Validation requires the model to prioritize the perfect points at the top of the list.
- **Groups:** Each track is treated as a "query group". The model learns to sort bars _within_ a specific track relative to each other, rather than learning a global absolute threshold.

### Dual Rankers

Mixing requires two distinct musical decisions. `BeatBotModel` wraps two separate LightGBM rankers:

1.  **Entry Ranker (`self.entry_model`)**:
    - **Goal:** Find structural beginnings (Intro starts, breakdowns).
    - **Configuration:** Highly regularized (`reg_lambda=15.0`) with shallower trees (`max_depth=3`, `num_leaves=6`). This prevents overfitting to specific songs, forcing the model to learn general structural rules.
2.  **Exit Ranker (`self.exit_model`)**:
    - **Goal:** Find structural endings (Outros, Chorus ends).
    - **Configuration:** Less regularization (`reg_lambda=5.0`), deeper trees (`max_depth=4`), allowing it to capture more complex energy dynamics indicative of a mix-out point.

## 2. Training Strategy

### Graded Relevance Labels

To train the ranker effectively, `FeatureExtractor.extract_labels` generates graded targets:

- **2 (Perfect):** The exact bar annotated by a human expert.
- **1 (Acceptable):** Bars within ±2 bars of the annotation (musically valid alternatives).
- **0 (Irrelevant):** All other bars.

### Feature Consistency

The model relies on `FeatureExtractor` (`src/features.py`) to ensure training and inference pipelines are identical. This includes:

- **Rolling Context:** +/- 8 bar energy averages.
- **Key-Invariant Chroma:** Rotating pitch vectors to the track's Tonic so the model learns harmonic function (e.g., "Dominant") rather than specific notes.
- **Future Contrast:** explicitly calculating "drop anticipation" features.

## 3. Inference & Prediction

### Scoring

```python
model = BeatBotModel()
model.load("beatbot_lgb.pkl")
df_scores = model.predict_track(track)
# Returns DataFrame with raw ranking scores: ['bar_index', 'score_in', 'score_out']
```

### Selection Logic (`predict_cue_points`)

To select the final suggestions from the raw scores:

1.  **Sort:** All bars are sorted by their predicted score.
2.  **Greedy Selection:** The top candidate is picked.
3.  **Suppression:** Any subsequent candidates within `min_dist_bars` (default 16) of a selected point are skipped to ensure diversity.
4.  **Top-K:** The process repeats until K (default 3) points are found.

## 4. Hyperparameters

| Parameter             | Entry Model  | Exit Model   | Reason                                   |
| :-------------------- | :----------- | :----------- | :--------------------------------------- |
| **Objective**         | `lambdarank` | `lambdarank` | Optimizes list order (NDCG)              |
| **Num Leaves**        | 6            | 10           | Entry cues are structurally simpler      |
| **Max Depth**         | 3            | 4            | Exit cues depend on complex context      |
| **Reg Lambda**        | 15.0         | 5.0          | Entry data is noisier; needs constraints |
| **Min Child Samples** | 40           | 20           | Prevents splitting on rare outliers      |

## 5. Why LightGBM LambdaRank?

1.  **Context Awareness:** It learns that "Bar 33 is better than Bar 32", which is more robust than "Bar 33 is a Cue".
2.  **Imbalance Handling:** DJ cue points are rare (<1% of bars). Ranking objectives handle this naturally by focusing on the top of the list.
3.  **Speed:** Inference takes milliseconds per track, enabling real-time feedback.
