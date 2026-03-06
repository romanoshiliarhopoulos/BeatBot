// TypeScript interfaces mirroring the BeatBot Pydantic schemas

export interface TrackMeta {
  track_id: string
  duration: number
  tempo: number
  key: string | null
  camelot: string | null
  num_bars: number
  has_cue_labels: boolean
  collection: 'custom' | 'm-djcue'
}

export interface PredictResponse {
  track_id: string
  num_bars: number
  bar_times: number[]   // seconds per bar index
  score_in: number[]    // normalised [0,1] entry scores
  score_out: number[]   // normalised [0,1] exit scores
  entry_sec: number
  exit_sec: number
  method: 'model' | 'heuristic'
  // Optional per-bar feature arrays, all normalised [0,1]
  energy?: number[]
  bass_energy?: number[]
  high_energy?: number[]
  mid_energy?: number[]
  beat_strength?: number[]
  vocal_presence?: number[]
}

export interface CueEditRequest {
  cue_type: 'entry' | 'exit'
  timestamp_sec: number
  source: 'user_drag' | 'user_input'
}

export interface CueEditResponse {
  track_id: string
  cue_type: string
  accepted_sec: number
  bar_index: number
}

export interface QueueItem {
  position: number
  track_id: string
  entry_sec: number
  exit_sec: number
}

export interface QueueState {
  current_index: number
  tracks: QueueItem[]
}

export interface EarlyTransitionResponse {
  next_track_id: string
  entry_sec: number
  exit_sec: number
  fade_secs: number
}

// WebSocket push event types
export type WsEvent =
  | { type: 'playback.tick'; track_id: string; elapsed_sec: number; duration_sec: number; progress: number; next_transition_in_sec: number }
  | { type: 'playback.track_changed'; prev_track_id: string | null; curr_track_id: string; curr_entry_sec: number; curr_exit_sec: number; queue_position: number }
  | { type: 'queue.updated'; tracks: QueueItem[] }
  | { type: 'cues.accepted'; track_id: string; cue_type: string; accepted_sec: number; bar_index: number }
  | { type: 'model.warning'; track_id: string; message: string; entry_sec: number; exit_sec: number }
  | { type: 'error'; code: string; message: string; recoverable: boolean }
  | { type: 'pong' }

// ── Mixes ──────────────────────────────────────────────────────────────────

/** A user-defined ordered subset of library tracks, stored in localStorage. */
export interface Mix {
  id: string
  name: string
  /** Key from MIX_COLORS palette. Defaults to 'purple'. */
  color?: string
  /** Ordered list of track_ids in this mix. */
  trackIds: string[]
  createdAt: number
}

// Local UI state
export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'crossfading' | 'paused'

export interface DeckInfo {
  track: TrackMeta | null
  prediction: PredictResponse | null
  /** entry_sec can be overridden by user */
  entry_sec: number
  exit_sec: number
  /** Object URL for the local audio file, used by WaveformView */
  audioSrc?: string
}
