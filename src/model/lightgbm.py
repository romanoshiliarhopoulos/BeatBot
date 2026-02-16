import numpy as np
import pandas as pd
import lightgbm as lgb
import pickle
from pathlib import Path
from typing import List, Dict, Optional, Tuple, Any
from scipy.signal import find_peaks

from track import Track
from features import FeatureExtractor

class BeatBotModel:
    """
    A wrapper around LightGBM classifiers for detecting Entry and Exit cue points.
    Trains two separate binary classifiers: one for 'is_cue_in' and one for 'is_cue_out'.
    """
    
    def __init__(self, models_dir: str = "models"):
        self.models_dir = Path(models_dir)
        self.entry_model = None
        self.exit_model = None

        # Valid features list is handled by FeatureExtractor to ensure consistency
        self.feature_cols = FeatureExtractor.FEATURES

    def _prepare_data(self, tracks: List[Track]) -> Tuple[pd.DataFrame, pd.DataFrame]:
        """
        Extracts features and labels from a list of tracks and returns X, y_in, y_out.
        """
        all_features = []
        all_labels = []
        
        print(f"Extracting features for {len(tracks)} tracks...")
        for t in tracks:
            # Features
            df_feats = FeatureExtractor.extract(t) 
            
            # Labels
            df_labels = FeatureExtractor.extract_labels(t)
            
            all_features.append(df_feats)
            all_labels.append(df_labels)
            
        X_full = pd.concat(all_features, ignore_index=True)
        y_full = pd.concat(all_labels, ignore_index=True)
        
        # Filter to only the feature columns we want to train on
        # We use a subset of what FeatureExtractor returns based on our selection analysis
        # If columns are missing, we add them as 0/NaN
        available_cols = [c for c in self.feature_cols if c in X_full.columns]
        if len(available_cols) < len(self.feature_cols):
            missing = set(self.feature_cols) - set(available_cols)
            print(f"Warning: Missing features in extraction: {missing}")
        
        X = X_full[available_cols].copy()
        
        return X, y_full


    def fit(self, X: pd.DataFrame, y_in: pd.Series, y_out: pd.Series,
            X_val: Optional[pd.DataFrame] = None, 
            y_in_val: Optional[pd.Series] = None, 
            y_out_val: Optional[pd.Series] = None):
        """
        Trains the models directly on provided feature/label DataFrames.
        If validation data is provided, it performs early stopping and records evaluation results.
        Returns a dict with eval results for 'entry' and 'exit'.
        """
        evals_history = {'entry': {}, 'exit': {}}
        
        # --- Entry Cue Model ---
        pos_count = y_in.sum()
        neg_count = len(y_in) - pos_count
        scale_pos_weight = neg_count / pos_count if pos_count > 0 else 1.0
        
        # "Nuclear Option" Regularization
        params = {
            'n_estimators': 2000,
            'learning_rate': 0.005,
            'num_leaves': 5,            
            'max_depth': 3,             
            'min_child_samples': 100,  
            'subsample': 0.5,           
            'colsample_bytree': 0.5,    
            'reg_alpha': 1.0,           
            'reg_lambda': 1.0,          
            'n_jobs': -1,
            'random_state': 42,
            'verbose': -1,
            'metric': ['binary_logloss', 'auc']
        }
        
        print("Training Entry Model...")
        self.entry_model = lgb.LGBMClassifier(**params, scale_pos_weight=scale_pos_weight)
        
        fit_params_in = {}
        if X_val is not None and y_in_val is not None:
             fit_params_in['eval_set'] = [(X, y_in), (X_val, y_in_val)]
             fit_params_in['eval_names'] = ['Train', 'Val']
             fit_params_in['callbacks'] = [
                 lgb.early_stopping(stopping_rounds=100, verbose=False),
                 lgb.log_evaluation(0) # silent
             ]
        
        self.entry_model.fit(X, y_in, **fit_params_in)
        if hasattr(self.entry_model, 'evals_result_'):
             evals_history['entry'] = self.entry_model.evals_result_
        
        # --- Exit Cue Model ---
        print("Training Exit Model...")
        pos_count = y_out.sum()
        neg_count = len(y_out) - pos_count
        scale_pos_weight = neg_count / pos_count if pos_count > 0 else 1.0

        self.exit_model = lgb.LGBMClassifier(**params, scale_pos_weight=scale_pos_weight)
        
        fit_params_out = {}
        if X_val is not None and y_out_val is not None:
             fit_params_out['eval_set'] = [(X, y_out), (X_val, y_out_val)]
             fit_params_out['eval_names'] = ['Train', 'Val']
             fit_params_out['callbacks'] = [
                 lgb.early_stopping(stopping_rounds=100, verbose=False),
                 lgb.log_evaluation(0)
             ]

        self.exit_model.fit(X, y_out, **fit_params_out)
        if hasattr(self.exit_model, 'evals_result_'):
             evals_history['exit'] = self.exit_model.evals_result_
             
        return evals_history

    def train(self, tracks: List[Track]):
        """
        Trains the Entry and Exit models using the provided tracks.
        """
        print("Preparing Training Data...")
        X, y_full = self._prepare_data(tracks)
        
        self.fit(X, y_full['is_cue_in'], y_full['is_cue_out'])
        print("Training Complete.")

    def predict_track(self, track: Track) -> pd.DataFrame:
        """
        Predicts Entry and Exit probabilities for a single track.
        Returns a DataFrame with ['bar_index', 'prob_in', 'prob_out']
        """
        if self.entry_model is None or self.exit_model is None:
            raise ValueError("Models are not trained. Call train() or load() first.")
            
        # Extract features
        X_raw = FeatureExtractor.extract(track)
        
        # Ensure we have the right columns in the right order
        # (LightGBM is sensitive to column order/presence)
        available_cols = [c for c in self.feature_cols if c in X_raw.columns]
        X = X_raw[available_cols].copy()
        
        # Predict Probabilities
        prob_in = self.entry_model.predict_proba(X)[:, 1]
        prob_out = self.exit_model.predict_proba(X)[:, 1]
        
        results = pd.DataFrame({
            'bar_index': range(track.num_bars),
            'prob_in': prob_in,
            'prob_out': prob_out
        })
        
        return results

    def predict_cue_points(self, track: Track, top_k: int = 3, threshold: float = 0.05, min_dist_bars: int = 16) -> Dict[str, List[Dict[str, Any]]]:
        """
        Intelligent prediction that finds the BEST cue points for a track.
        Instead of a hard 0.5 threshold, it finds the local maxima above a custom threshold.
        Returns the top_k candidates for entry and exit, sorted by probability.
        """
        if self.entry_model is None or self.exit_model is None:
            raise ValueError("Models are not trained.")
            
        # 1. Get raw probabilities
        df_probs = self.predict_track(track)
        probs_in = df_probs['prob_in'].values
        probs_out = df_probs['prob_out'].values
        
        # Helper to find peaks
        def get_top_candidates(probs, k):
            # Find peaks (local maxima)
            peaks, _ = find_peaks(probs, height=threshold, distance=min_dist_bars)
            
            # If no peaks found, try lower threshold or return empty
            if len(peaks) == 0:
                return []
            
            # Get peak probabilities
            peak_probs = probs[peaks]
            
            # Create list of candidates
            candidates = []
            for idx, p in zip(peaks, peak_probs):
                candidates.append({
                    "bar_index": int(idx),
                    "probability": float(p),
                    "timestamp": float(track.bars[idx]) if idx < len(track.bars) else 0.0
                })
            
            # Sort by probability descending
            candidates.sort(key=lambda x: x["probability"], reverse=True)
            
            # Return top k
            return candidates[:k]

        return {
            "cue_in": get_top_candidates(probs_in, top_k),
            "cue_out": get_top_candidates(probs_out, top_k)
        }

    def save(self, filename: str = "beatbot_lgb.pkl"):
        """Saves current state to disk"""
        self.models_dir.mkdir(parents=True, exist_ok=True)
        path = self.models_dir / filename
        with open(path, 'wb') as f:
            pickle.dump({
                'entry_model': self.entry_model,
                'exit_model': self.exit_model,
                'features': self.feature_cols
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
            self.exit_model = data['exit_model']
            if 'features' in data:
                self.feature_cols = data['features']
        print(f"Model loaded from {path}")
