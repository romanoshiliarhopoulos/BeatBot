import axios from 'axios'
import type {
  TrackMeta,
  PredictResponse,
  CueEditRequest,
  CueEditResponse,
  QueueState,
  EarlyTransitionResponse,
} from '../types'

const api = axios.create({ baseURL: '/api' })

// ── Library ────────────────────────────────────────────────────────────────

export async function fetchTracks(): Promise<TrackMeta[]> {
  const { data } = await api.get<TrackMeta[]>('/tracks')
  return data
}

// ── Prediction ────────────────────────────────────────────────────────────

export async function predictCues(trackId: string): Promise<PredictResponse> {
  const { data } = await api.post<PredictResponse>(
    `/predict/${encodeURIComponent(trackId)}`
  )
  return data
}

// ── Cue editing ──────────────────────────────────────────────────────────

export async function editCue(
  trackId: string,
  body: CueEditRequest
): Promise<CueEditResponse> {
  const { data } = await api.patch<CueEditResponse>(
    `/cues/${encodeURIComponent(trackId)}`,
    body
  )
  return data
}

// ── Queue ────────────────────────────────────────────────────────────────

export async function fetchQueue(): Promise<QueueState> {
  const { data } = await api.get<QueueState>('/queue')
  return data
}

export async function addToQueue(trackIds: string[]): Promise<QueueState> {
  const { data } = await api.post<QueueState>('/queue', { track_ids: trackIds })
  return data
}

export async function reorderQueue(
  fromPosition: number,
  toPosition: number
): Promise<QueueState> {
  const { data } = await api.patch<QueueState>('/queue/reorder', {
    from_position: fromPosition,
    to_position: toPosition,
  })
  return data
}

export async function removeFromQueue(position: number): Promise<QueueState> {
  const { data } = await api.delete<QueueState>(`/queue/${position}`)
  return data
}

export async function clearQueue(): Promise<QueueState> {
  const { data } = await api.delete<QueueState>('/queue')
  return data
}

// ── Transition ────────────────────────────────────────────────────────────

export async function triggerEarlyTransition(
  fadeSecs = 7
): Promise<EarlyTransitionResponse> {
  const { data } = await api.post<EarlyTransitionResponse>(
    '/transition/early',
    { fade_secs: fadeSecs }
  )
  return data
}

// ── Audio URL helper ─────────────────────────────────────────────────────

export function audioUrl(trackId: string): string {
  return `/audio/${encodeURIComponent(trackId)}`
}
