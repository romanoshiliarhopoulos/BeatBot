import numpy as np
import pandas as pd
import lightgbm as lgb
import pickle
from pathlib import Path
from typing import List, Dict, Optional, Tuple, Any

from track import Track
from features import FeatureExtractor

class BeatBotModel:
    """
    A wrapper around LightGBM rankers for detecting Entry and Exit cue points.
    Trains two separate LambdaRank models: one for 'is_cue_in' and one for 'is_cue_out'.

    Each track is treated as a query group; bars within each track are ranked by
    their relevance as a cue point (0 = not a cue, 1 = cue). The model learns a
    relative ordering within each track rather than a global classification boundary,
    which is a better fit for the task of finding the best 1-3 cue points per track.
    """
    
    def __init__(self, models_dir: str = "models"):
        self.models_dir = Path(models_dir)
        self.entry_model = None
        self.exit_model = None

        # Valid features list is handled by FeatureExtractor to ensure consistency
        self.feature_cols = FeatureExtractor.FEATURES

    @staticmethod
    def compute_groups(track_ids: pd.Series) -> np.ndarray:
        """
        Computes LightGBM group sizes from an ordered series of track IDs.
        Each contiguous run of the same track_id becomes one group.
        Returns an int array where each element is the number of bars in that group.
        Example: [A, A, A, B, B] -> [3, 2]
        """
        track_ids = track_ids.reset_index(drop=True)
        runs = (track_ids != track_ids.shift()).cumsum()
        return runs.groupby(runs).size().values

    def _prepare_data(self, tracks: List[Track]) -> Tuple[pd.DataFrame, pd.DataFrame, np.ndarray]:
        """
        Extracts features, labels, and group sizes from a list of tracks.
        Returns (X, y_full, groups) where groups is an array of bar counts per track.
        """
        all_features = []
        all_labels = []
        group_sizes = []
        
        print(f"Extracting features for {len(tracks)} tracks...")
        for t in tracks:
            df_feats = FeatureExtractor.extract(t)
            df_labels = FeatureExtractor.extract_labels(t)
            all_features.append(df_feats)
            all_labels.append(df_labels)
            group_sizes.append(len(df_feats))
            
        X_full = pd.concat(all_features, ignore_index=True)
        y_full = pd.concat(all_labels, ignore_index=True)
        
        available_cols = [c for c in self.feature_cols if c in X_full.columns]
        if len(available_cols) < len(self.feature_cols):
            missing = set(self.feature_cols) - set(available_cols)
            print(f"Warning: Missing features in extraction: {missing}")
        
        X = X_full[available_cols].copy()
        
        return X, y_full, np.array(group_sizes)

    def fit(self, X: pd.DataFrame, y_in: pd.Series, y_out: pd.Series,
            groups_train: np.ndarray,
            X_val: Optional[pd.DataFrame] = None, 
            y_in_val: Optional[pd.Series] = None, 
            y_out_val: Optional[pd.Series] = None,
            groups_val: Optional[np.ndarray] = None):
        """
        Trains the LambdaRank models on provided feature/label DataFrames.

        groups_train: array of group sizes (bars per track) for the training set.
                      Must match the order of rows in X / y_in / y_out.
        groups_val:   same, for the validation set. Required when X_val is provided.

        Returns a dict with eval history for 'entry' and 'exit'.
        """
        evals_history = {'entry': {}, 'exit': {}}

        # Base params shared by both rankers
        _base = {
            'n_estimators': 3000,
            'learning_rate': 0.005,
            'subsample': 0.6,
            'colsample_bytree': 0.6,
            'reg_alpha': 0.5,
            'min_split_gain': 0.01,
            'n_jobs': -1,
            'random_state': 42,
            'verbose': -1,
            'objective': 'lambdarank',
            'metric': 'ndcg',
            'eval_at': [1, 3, 5],
        }

        # Entry ranker: more regularised — CV showed heavy train/val gap
        entry_params = {
            **_base,
            'num_leaves': 6,          # was 10: fewer leaves = simpler trees
            'max_depth': 3,           # was 4
            'min_child_samples': 40,  # was 20: harder to split on rare events
            'reg_lambda': 15.0,       # was 5.0: strong weight penalty
        }

        # Exit ranker: current params working well, leave mostly unchanged
        exit_params = {
            **_base,
            'num_leaves': 10,
            'max_depth': 4,
            'min_child_samples': 20,
            'reg_lambda': 5.0,
        }

        # --- Entry Cue Ranker ---
        print("Training Entry Ranker...")
        self.entry_model = lgb.LGBMRanker(**entry_params)
        
        fit_params_in = {'group': groups_train}
        if X_val is not None and y_in_val is not None and groups_val is not None:
            fit_params_in['eval_set'] = [(X, y_in), (X_val, y_in_val)]
            fit_params_in['eval_group'] = [groups_train, groups_val]
            fit_params_in['eval_names'] = ['Train', 'Val']
            fit_params_in['callbacks'] = [
                lgb.early_stopping(stopping_rounds=100, verbose=False),
                lgb.log_evaluation(0),
            ]
        
        self.entry_model.fit(X, y_in, **fit_params_in)
        if hasattr(self.entry_model, 'evals_result_'):
            evals_history['entry'] = self.entry_model.evals_result_
        
        # --- Exit Cue Ranker ---
        print("Training Exit Ranker...")
        self.exit_model = lgb.LGBMRanker(**exit_params)
        
        fit_params_out = {'group': groups_train}
        if X_val is not None and y_out_val is not None and groups_val is not None:
            fit_params_out['eval_set'] = [(X, y_out), (X_val, y_out_val)]
            fit_params_out['eval_group'] = [groups_train, groups_val]
            fit_params_out['eval_names'] = ['Train', 'Val']
            fit_params_out['callbacks'] = [
                lgb.early_stopping(stopping_rounds=100, verbose=False),
                lgb.log_evaluation(0),
            ]
        
        self.exit_model.fit(X, y_out, **fit_params_out)
        if hasattr(self.exit_model, 'evals_result_'):
            evals_history['exit'] = self.exit_model.evals_result_
             
        return evals_history

    def train(self, tracks: List[Track]):
        """
        Trains the Entry and Exit rankers using the provided tracks.
        """
        print("Preparing Training Data...")
        X, y_full, groups = self._prepare_data(tracks)
        self.fit(X, y_full['is_cue_in'], y_full['is_cue_out'], groups_train=groups)
        print("Training Complete.")

    def predict_track(self, track: Track) -> pd.DataFrame:
        """
        Produces Entry and Exit ranking scores for every bar in a single track.
        Returns a DataFrame with ['bar_index', 'score_in', 'score_out'].
        Higher score means the model ranks that bar as a better cue point candidate.
        """
        if self.entry_model is None or self.exit_model is None:
            raise ValueError("Models are not trained. Call train() or load() first.")
            
        X_raw = FeatureExtractor.extract(track)
        available_cols = [c for c in self.feature_cols if c in X_raw.columns]
        X = X_raw[available_cols].copy()
        
        # LGBMRanker.predict() returns raw ranking scores (not probabilities)
        score_in  = self.entry_model.predict(X)
        score_out = self.exit_model.predict(X)
        
        return pd.DataFrame({
            'bar_index': range(track.num_bars),
            'score_in':  score_in,
            'score_out': score_out,
        })

    def predict_cue_points(self, track: Track, top_k: int = 3, min_dist_bars: int = 16) -> Dict[str, List[Dict[str, Any]]]:
        """
        Returns the top-k entry and exit cue point candidates ranked by score.

        Selection logic:
          1. Sort all bars by ranking score (descending).
          2. Greedily pick bars that are at least min_dist_bars apart.
          3. Return the top_k survivors.

        This replaces the old peak-detection + threshold approach. No threshold is
        needed because the ranker already orders bars by relative quality within the track.
        """
        if self.entry_model is None or self.exit_model is None:
            raise ValueError("Models are not trained.")
            
        df_scores = self.predict_track(track)
        scores_in  = df_scores['score_in'].values
        scores_out = df_scores['score_out'].values

        def get_top_candidates(scores: np.ndarray, k: int) -> List[Dict[str, Any]]:
            ranked_indices = np.argsort(scores)[::-1]  # best first
            candidates: List[Dict[str, Any]] = []
            for idx in ranked_indices:
                bar_idx = int(idx)
                # Enforce minimum spacing between selected cue points
                if any(abs(bar_idx - c['bar_index']) < min_dist_bars for c in candidates):
                    continue
                candidates.append({
                    "bar_index": bar_idx,
                    "score":     float(scores[idx]),
                    "timestamp": float(track.bars[bar_idx]) if bar_idx < len(track.bars) else 0.0,
                })
                if len(candidates) == k:
                    break
            return candidates

        return {
            "cue_in":  get_top_candidates(scores_in,  top_k),
            "cue_out": get_top_candidates(scores_out, top_k),
        }

    def save(self, filename: str = "beatbot_lgb.pkl"):
        """Saves current state to disk"""
        self.models_dir.mkdir(parents=True, exist_ok=True)
        path = self.models_dir / filename
        with open(path, 'wb') as f:
            pickle.dump({
                'entry_model': self.entry_model,
                'exit_model':  self.exit_model,
                'features':    self.feature_cols,
            }, f)
        print(f"Model saved to {path}")

    def load(self, filename: str = "beatbot_lgb.pkl"):
        """Loads state from disk"""
        path = self.models_dir / filename
        if not path.exists():
            raise FileNotFoundError(f"Model file not found at {path}")
        with open(path, 'rb') as f:
            data = pickle.load(f)
            self.entry_model = data['entry_model']
            self.exit_model  = data['exit_model']
            if 'features' in data:
                self.feature_cols = data['features']
        print(f"Model loaded from {path}")
