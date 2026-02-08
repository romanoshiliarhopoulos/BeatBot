# Project: BeatBot - The AI DJ

## Core Goal

The primary goal of the BeatBot project is to develop a machine learning model that emulates the decision-making process of a human DJ. The model will analyze audio files to automatically identify the optimal entry and exit points for seamless and musical DJ mixing.

## Project Scope

*   **Task:** The model will be trained to predict the **Top 3 Entry ("IN") Cue Points** and the **Top 3 Exit ("OUT") Cue Points** for any given track.
*   **Genre Focus:** The project is specifically tailored to **House Music** and its various subgenres (e.g., Deep House, Tech House, Progressive House). The model is intended to be a specialist in this domain.

## Methodology

### 1. Data Sources
The model will be trained on a curated dataset of house music, combining two primary sources:
*   **M-DJCUE Dataset:** A foundational academic dataset containing professionally annotated cue points for electronic music.
*   **Manually Annotated Tracks:** A custom collection of house music tracks annotated by the user to expand the dataset and target the specific genre.

### 2. Feature Engineering
To understand the musical context, the model will be trained on a rich set of audio features extracted using the `librosa` library, including:
*   **Rhythmic Features:** Tempo, beat grids, downbeats, and beat strength.
*   **Structural Features:** The position of bars within the track and the identification of intro/outro sections.
*   **Timbral & Harmonic Features:** Spectral characteristics (contrast, flatness), harmonic/percussive components, and chroma features to represent the harmony.

### 3. Modeling Approach
The task will be framed as a **ranking problem**.
*   The model will first identify all potential cue points (e.g., the start of every bar).
*   It will then learn to assign a "goodness" score to each of these candidates for both entry and exit.
*   Finally, the top 3 scoring candidates for "IN" and "OUT" will be selected as the predicted cue points.
