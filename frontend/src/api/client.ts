import axios from 'axios'
import type {
  TrackMeta,
  PredictResponse,
  CueEditRequest,
  CueEditResponse,
  QueueState,
  EarlyTransitionResponse,
} from '../types'
import { firebaseAuth } from '../lib/firebase'

// In production VITE_API_BASE_URL points at the Cloud Run service.
// In local dev it is unset, so the Vite proxy (/api → localhost:8000) is used.
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api'

const api = axios.create({ baseURL: BASE_URL })

// Attach Firebase ID token to every request when a user is signed in.
// The backend's verify_token dependency reads Authorization: Bearer <token>.
api.interceptors.request.use(async (config) => {
  const user = firebaseAuth?.currentUser
  if (user) {
    try {
      const token = await user.getIdToken()
      config.headers = config.headers ?? {}
      config.headers['Authorization'] = `Bearer ${token}`
    } catch {
      // Token fetch failed — let the request proceed without the header;
      // the server will return 401 if authentication is required.
    }
  }
  return config
})

// ── Library ────────────────────────────────────────────────────────────────

export async function fetchTracks(): Promise<TrackMeta[]> {
  const { data } = await api.get<TrackMeta[]>('/tracks')
  return data
}

export async function deleteTrack(trackId: string): Promise<void> {
  await api.delete(`/tracks/${encodeURIComponent(trackId)}`)
}

export async function purgeTracks(keepTrackIds: string[]): Promise<{ deleted: number }> {
  const { data } = await api.post<{ deleted: number }>('/tracks/purge', { keep_track_ids: keepTrackIds })
  return data
}

export async function clearAllTracks(): Promise<{ deleted: number }> {
  const { data } = await api.delete<{ deleted: number }>('/tracks')
  return data
}

export async function fetchFeatureIds(): Promise<string[]> {
  const { data } = await api.get<string[]>('/features')
  return data
}

// ── Prediction ────────────────────────────────────────────────────────────

export async function predictCues(
  trackId: string,
  pklBytes?: Uint8Array,
): Promise<PredictResponse> {
  if (pklBytes && pklBytes.length > 0) {
    const { data } = await api.post<PredictResponse>(
      `/predict/${encodeURIComponent(trackId)}`,
      pklBytes,
      { headers: { 'Content-Type': 'application/octet-stream' } },
    )
    return data
  }
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

