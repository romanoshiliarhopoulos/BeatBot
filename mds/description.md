# Project: BeatBot - The AI DJ

## Core Goal

The primary goal of the BeatBot project is to develop a machine learning model that emulates the decision-making process of a human DJ. The model will analyze audio files to automatically identify the optimal **Entry (IN)** and **Exit (OUT)** points for seamless and musical mixing.

## Project Scope

- **Task:** The model will be trained to **Rank** every bar of a track based on its suitability as a cue point, enabling it to suggest the **Top 3 Entry** and **Top 3 Exit** points.
- **Genre Focus:** The project is specifically tailored to **House Music** and its various subgenres. The model is intended to be a specialist in this domain.

## Methodology

### 1. Data Sources

The model relies on a curated dataset of house music:

- **M-DJCUE Dataset:** A foundational academic dataset (Electronic Dance Music).
- **Manually Annotated Tracks:** A custom collection of House Music tracks annotated by the user.

### 2. Feature Engineering

We use a centralized `FeatureExtractor` to compute 40+ features per bar, organized into 9 tiers:

- **Structure:** Bar position, phrase position, distance to section boundaries.
- **Energy Dynamics:** Rolling windows (past/future energy), drops, and breakdowns.
- **Musical Content:** Vocal presence, percussion intensity, and key-invariant harmonic profiles.

### 3. Modeling Approach: Learning-to-Rank

Instead of simple classification, BeatBot uses a **LambdaRank** objective (via LightGBM):

- **Relative Ordering:** The model learns that "Bar 33 is a _better_ cue than Bar 32" rather than just "Bar 33 is a cue."
- **Dual Models:** We train two separate rankers—one optimized for finding **Entries** (Start of track/breakdown) and one for **Exits** (End of track/drop).
- **Relevance Grading:** Training uses graded labels (2=Perfect, 1=Acceptable, 0=None) to optimize the **NDCG** metric.

### 4. Evaluation Strategy

- **NDCG (Normalized Discounted Cumulative Gain):** Measures the quality of the ranking order.
- **Soft Precision:** Predictions within a ±1 bar tolerance window are considered valid.
- **Phrase Consonance:** Predictions that land on valid phrase boundaries (e.g., every 16 or 32 bars) relative to the ground truth are rewarded.
