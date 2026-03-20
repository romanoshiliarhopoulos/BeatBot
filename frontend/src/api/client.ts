import axios from 'axios'
import type {
  TrackMeta,
  Mix,
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
      {
        headers: { 'Content-Type': 'application/octet-stream' },
      },
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

// ── Mixes ─────────────────────────────────────────────────────────────────

export async function fetchMixes(): Promise<Mix[]> {
  console.log('[client] fetchMixes → GET /mixes')
  const { data } = await api.get<Mix[]>('/mixes')
  console.log('[client] fetchMixes ← response:', data)
  return data
}

export async function apiCreateMix(mix: Mix): Promise<Mix> {
  console.log('[client] apiCreateMix → POST /mixes', mix)
  const { data } = await api.post<Mix>('/mixes', mix)
  console.log('[client] apiCreateMix ← response:', data)
  return data
}

export async function apiUpdateMix(
  id: string,
  updates: Partial<Pick<Mix, 'name' | 'trackIds' | 'color'>>
): Promise<Mix> {
  console.log('[client] apiUpdateMix → PUT /mixes/' + id, updates)
  const { data } = await api.put<Mix>(`/mixes/${encodeURIComponent(id)}`, updates)
  console.log('[client] apiUpdateMix ← response:', data)
  return data
}

export async function apiDeleteMix(id: string): Promise<void> {
  console.log('[client] apiDeleteMix → DELETE /mixes/' + id)
  await api.delete(`/mixes/${encodeURIComponent(id)}`)
  console.log('[client] apiDeleteMix ← done')
}

// ── Upload ─────────────────────────────────────────────────────────────────

export async function uploadYoutube(videoId: string, title: string): Promise<Blob> {
  const formData = new FormData()
  formData.append('video_id', videoId)
  formData.append('title', title)
  
  const { data } = await api.post<Blob>('/upload/youtube', formData, {
    responseType: 'blob'
  })
  return data
}

export async function uploadLocal(file: File, onProgress?: (percent: number) => void): Promise<TrackMeta> {
  const formData = new FormData()
  formData.append('file', file)
  
  const { data } = await api.post<TrackMeta>('/upload/local', formData, {
    onUploadProgress: (progressEvent) => {
      if (progressEvent.total && onProgress) {
        const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
        onProgress(percentCompleted);
      }
    }
  })
  return data
}

export async function searchYoutube(q: string): Promise<any[]> {
  const { data } = await api.get<any[]>('/search/youtube', { params: { q } })
  return data
}
