# BeatBot — AI-Powered DJ Mixing Tool

**[Live App: BeatBot](https://beatbot-35280.web.app)**

BeatBot is an AI-powered mixing assistant that analyzes house music tracks and automatically selects the optimal **entry** and **exit** cue points for seamless DJ transitions. It uses a custom Learning-to-Rank model to analyze and rank track structures, while a React-based frontend provides a professional DJ deck environment directly in the browser to visualize and execute live crossfades.

---

## 🧠 How the Model Works

BeatBot evaluates tracks using a **Learning-to-Rank (LambdaRank)** approach. Instead of relying on a simple binary classification logic ("Is this a cue point or not?"), it uses a **Dual Ranker architecture** powered by LightGBM (`src/model/lightgbm.py`) to rank every bar in a specific track relative to the others. 

1. **Feature Extraction:** Tracks are natively processed using `librosa` behind the scenes. The engine slices the track into rhythmic grids and extracts time, spatial, and energy metrics (MFCCs, spectral contrast, beat continuity).
2. **Dual Rankers:**
   - **Entry Ranker:** Heavily regularized to pinpoint core structural beginnings (e.g., Intro starts, post-breakdown drops), preventing it from overfitting to specific song gimmicks.
   - **Exit Ranker:** Configured with deeper trees to capture the nuanced energy drain indicative of an optimal mix-out point (e.g., Chorus decay, outro starts).
3. **API & Frontend Resolution:** The backend serves a normalized probability distribution curve to the frontend. The web app intelligently determines precise time-based cue points using real-time playback duration.

---

## 🛠️ Local Setup & Configuration

The project operates through three synchronized components: a React Frontend, a Python API backend, and a Local Daemon sidecar.

### Local Daemon / CLI
The daemon acts as a local HTTP/WebSocket sidecar (`http://127.0.0.1:7337`). It coordinates file system extraction locally (preventing heavy song uploads), drives the machine-learning feature generation, and syncs imports.

**Setup:**
```bash
# From the root of the project, install the CLI
pip install -e .

# Start the local daemon sidecar
beatbot daemon

# (Optional) Install it to start automatically on macOS login
beatbot daemon --autostart
```
