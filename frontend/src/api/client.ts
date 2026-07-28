import axios from 'axios'
import type {
  TrackMeta,
  Mix,
  PredictResponse,
  CueEditRequest,
  CueEditResponse,
  QueueState,
  EarlyTransitionResponse,
  TransitionConfig,
  CreateSessionResponse,
  SessionState,
  SessionSummary,
  SongRequest,
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

export async function suggestTransition(
  outTrackId: string,
  inTrackId: string,
  outExitSec: number,
  inEntrySec: number,
  fadeSecs: number,
): Promise<TransitionConfig> {
  // Backend returns snake_case; map to camelCase for frontend types.
  const { data } = await api.post(
    '/transition/suggest',
    {
      out_track_id: outTrackId,
      in_track_id: inTrackId,
      out_exit_sec: outExitSec,
      in_entry_sec: inEntrySec,
      fade_secs: fadeSecs,
    },
  )
  return {
    type: data.type,
    curve: data.curve,
    fadeSecs: data.fade_secs,
    bassSwapAt: data.bass_swap_at ?? null,
    filterStartHz: data.filter_start_hz ?? null,
    filterEndHz: data.filter_end_hz ?? null,
    delayTimeSec: data.delay_time_sec ?? null,
    delayFeedback: data.delay_feedback ?? null,
    silenceSec: data.silence_sec ?? null,
  }
}

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
  //('[client] fetchMixes → GET /mixes')
  const { data } = await api.get<Mix[]>('/mixes')
  //console.log('[client] fetchMixes ← response:', data)
  return data
}

export async function apiCreateMix(mix: Mix): Promise<Mix> {
  //console.log('[client] apiCreateMix → POST /mixes', mix)
  const { data } = await api.post<Mix>('/mixes', mix)
  //console.log('[client] apiCreateMix ← response:', data)
  return data
}

export async function apiUpdateMix(
  id: string,
  updates: Partial<Pick<Mix, 'name' | 'trackIds' | 'color'>>
): Promise<Mix> {
  //console.log('[client] apiUpdateMix → PUT /mixes/' + id, updates)
  const { data } = await api.put<Mix>(`/mixes/${encodeURIComponent(id)}`, updates)
  //console.log('[client] apiUpdateMix ← response:', data)
  return data
}

export async function apiDeleteMix(id: string): Promise<void> {
  //console.log('[client] apiDeleteMix → DELETE /mixes/' + id)
  await api.delete(`/mixes/${encodeURIComponent(id)}`)
  //console.log('[client] apiDeleteMix ← done')
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

// ── Live Sessions ─────────────────────────────────────────────────────

export async function createSession(): Promise<CreateSessionResponse> {
  const { data } = await api.post<CreateSessionResponse>('/sessions')
  return data
}

export async function getActiveSession(): Promise<SessionState> {
  const { data } = await api.get<SessionState>('/sessions/active')
  return data
}

export async function endSession(sessionId: string): Promise<void> {
  await api.delete(`/sessions/${encodeURIComponent(sessionId)}`)
}

export async function getSessionState(sessionId: string): Promise<SessionState> {
  const { data } = await api.get<SessionState>(`/sessions/${encodeURIComponent(sessionId)}`)
  return data
}

export async function getSessionHistory(): Promise<SessionSummary[]> {
  const { data } = await api.get<SessionSummary[]>('/sessions/history')
  return data
}

export async function getSessionRequests(sessionId: string): Promise<SongRequest[]> {
  const { data } = await api.get<SongRequest[]>(`/sessions/${encodeURIComponent(sessionId)}/requests`)
  return data
}

export async function resolveRequest(
  sessionId: string,
  requestId: string,
  status: 'accepted' | 'denied',
  track_id?: string,
): Promise<void> {
  await api.patch(`/sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(requestId)}`, { status, track_id })
}

export async function searchSessionLibrary(sessionId: string, q: string): Promise<TrackMeta[]> {
  const { data } = await api.get<TrackMeta[]>(`/sessions/${encodeURIComponent(sessionId)}/library`, { params: { q } })
  return data
}

export async function submitSongRequest(
  sessionId: string,
  body: { display_name: string; source: 'library' | 'youtube'; track_id?: string; youtube_url?: string; query: string },
): Promise<SongRequest> {
  const { data } = await api.post<SongRequest>(`/sessions/${encodeURIComponent(sessionId)}/requests`, body)
  return data
}
