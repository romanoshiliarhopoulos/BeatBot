/**
 * useAudioEngine — Web Audio API two-deck crossfade engine.
 *
 * Architecture:
 *   AudioContext
 *     ├── SourceNode (deckA) → GainNode A → destination
 *     └── SourceNode (deckB) → GainNode B → destination
 *
 * Decks ping-pong: A plays, B is preloaded. After crossfade, B plays, A is
 * reloaded with the track after next.
 */
import { useRef, useState, useCallback, useEffect } from 'react'
import { audioUrl } from '../api/client'

export type ActiveDeck = 'A' | 'B'

interface DeckRef {
  trackId: string | null
  buffer: AudioBuffer | null
  source: AudioBufferSourceNode | null
  gain: GainNode | null
  /** audioCtx.currentTime when source.start() was called */
  startedAtCtxTime: number
  /** audio file offset (seconds) we started from */
  startedAtOffset: number
}

function emptyDeck(): DeckRef {
  return {
    trackId: null,
    buffer: null,
    source: null,
    gain: null,
    startedAtCtxTime: 0,
    startedAtOffset: 0,
  }
}

export interface AudioEngineState {
  isPlaying: boolean
  activeDeck: ActiveDeck
  elapsed: number         // seconds into the currently playing audio file
  loadingA: boolean
  loadingB: boolean
}

export interface AudioEngine {
  state: AudioEngineState
  /** Fetch + decode audio for the given deck without starting playback */
  loadDeck: (deck: ActiveDeck, trackId: string) => Promise<void>
  /** Start playing from entrySec. Schedules auto-crossfade at exitSec. */
  play: (entrySec: number, exitSec: number, fadeSecs: number) => void
  /** Immediately trigger crossfade to the other deck */
  crossfadeNow: (entrySec: number, fadeSecs: number) => void
  /** Stop all playback */
  stop: () => void
  /** Resume AudioContext (required after user gesture on some browsers) */
  resume: () => Promise<void>
  /** Current elapsed seconds */
  getElapsed: () => number
}

export function useAudioEngine(): AudioEngine {
  const ctxRef = useRef<AudioContext | null>(null)
  const decks = useRef<{ A: DeckRef; B: DeckRef }>({
    A: emptyDeck(),
    B: emptyDeck(),
  })
  const activeDeckRef = useRef<ActiveDeck>('A')
  const crossfadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [state, setState] = useState<AudioEngineState>({
    isPlaying: false,
    activeDeck: 'A',
    elapsed: 0,
    loadingA: false,
    loadingB: false,
  })

  // Ticker: update elapsed every 250ms while playing
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const getCtx = useCallback((): AudioContext => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext()
    }
    return ctxRef.current
  }, [])

  const getElapsed = useCallback((): number => {
    const ctx = ctxRef.current
    if (!ctx) return 0
    const active = decks.current[activeDeckRef.current]
    if (!active.source) return 0
    return (ctx.currentTime - active.startedAtCtxTime) + active.startedAtOffset
  }, [])

  const startTicker = useCallback(() => {
    if (tickerRef.current) return
    tickerRef.current = setInterval(() => {
      const el = getElapsed()
      setState(s => ({ ...s, elapsed: el }))
    }, 250)
  }, [getElapsed])

  const stopTicker = useCallback(() => {
    if (tickerRef.current) {
      clearInterval(tickerRef.current)
      tickerRef.current = null
    }
  }, [])

  const loadDeck = useCallback(async (deck: ActiveDeck, trackId: string) => {
    setState(s => deck === 'A' ? { ...s, loadingA: true } : { ...s, loadingB: true })
    const ctx = getCtx()

    // Create/reuse GainNode for this deck
    if (!decks.current[deck].gain) {
      const g = ctx.createGain()
      g.connect(ctx.destination)
      decks.current[deck].gain = g
    }

    try {
      const resp = await fetch(audioUrl(trackId))
      const arrayBuf = await resp.arrayBuffer()
      const audioBuf = await ctx.decodeAudioData(arrayBuf)
      decks.current[deck].buffer = audioBuf
      decks.current[deck].trackId = trackId
    } catch (err) {
      console.error(`[AudioEngine] Failed to load deck ${deck}:`, err)
    } finally {
      setState(s => deck === 'A' ? { ...s, loadingA: false } : { ...s, loadingB: false })
    }
  }, [getCtx])

  const _startDeck = useCallback((
    deck: ActiveDeck,
    offsetSec: number,
  ) => {
    const ctx = getCtx()
    const deckRef = decks.current[deck]
    if (!deckRef.buffer || !deckRef.gain) return

    // Stop previous source on this deck if still running
    try { deckRef.source?.stop() } catch { /* already stopped */ }

    const source = ctx.createBufferSource()
    source.buffer = deckRef.buffer
    source.connect(deckRef.gain)
    source.start(0, Math.max(0, offsetSec))

    deckRef.source = source
    deckRef.startedAtCtxTime = ctx.currentTime
    deckRef.startedAtOffset = offsetSec
  }, [getCtx])

  const play = useCallback((
    entrySec: number,
    exitSec: number,
    fadeSecs: number,
  ) => {
    const ctx = getCtx()
    const deck = activeDeckRef.current
    const deckRef = decks.current[deck]
    if (!deckRef.buffer) {
      console.warn('[AudioEngine] play() called but deck buffer is empty')
      return
    }

    // Ensure gain nodes exist and are reset
    if (!deckRef.gain) {
      const g = ctx.createGain()
      g.connect(ctx.destination)
      deckRef.gain = g
    }
    deckRef.gain.gain.cancelScheduledValues(ctx.currentTime)
    deckRef.gain.gain.setValueAtTime(1, ctx.currentTime)

    _startDeck(deck, entrySec)

    setState(s => ({ ...s, isPlaying: true, activeDeck: deck }))
    startTicker()

    // Schedule auto-crossfade
    if (crossfadeTimerRef.current) clearTimeout(crossfadeTimerRef.current)
    const delay = Math.max(0, (exitSec - entrySec) * 1000)
    crossfadeTimerRef.current = setTimeout(() => {
      // Will be triggered by the parent if next deck is loaded
      // Just ramp out deck A — parent handles starting deck B
      const g = decks.current[deck].gain
      if (g) {
        g.gain.cancelScheduledValues(ctx.currentTime)
        g.gain.setValueAtTime(g.gain.value, ctx.currentTime)
        g.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeSecs)
      }
    }, delay)
  }, [getCtx, _startDeck, startTicker])

  const crossfadeNow = useCallback((entrySec: number, fadeSecs: number) => {
    const ctx = getCtx()
    const outDeck = activeDeckRef.current
    const inDeck: ActiveDeck = outDeck === 'A' ? 'B' : 'A'

    // Ensure gain nodes exist
    const outDeckRef = decks.current[outDeck]
    const inDeckRef  = decks.current[inDeck]

    if (outDeckRef.gain) {
      outDeckRef.gain.gain.cancelScheduledValues(ctx.currentTime)
      outDeckRef.gain.gain.setValueAtTime(outDeckRef.gain.gain.value, ctx.currentTime)
      outDeckRef.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeSecs)
    }

    if (!inDeckRef.gain) {
      const g = ctx.createGain()
      g.connect(ctx.destination)
      inDeckRef.gain = g
    }
    inDeckRef.gain.gain.cancelScheduledValues(ctx.currentTime)
    inDeckRef.gain.gain.setValueAtTime(0, ctx.currentTime)
    inDeckRef.gain.gain.linearRampToValueAtTime(1, ctx.currentTime + fadeSecs)

    _startDeck(inDeck, entrySec)

    activeDeckRef.current = inDeck
    setState(s => ({ ...s, activeDeck: inDeck, isPlaying: true }))
  }, [getCtx, _startDeck])

  const stop = useCallback(() => {
    if (crossfadeTimerRef.current) clearTimeout(crossfadeTimerRef.current)
    stopTicker()
    ;(['A', 'B'] as ActiveDeck[]).forEach(d => {
      try { decks.current[d].source?.stop() } catch { /* ignore */ }
      decks.current[d].source = null
      if (decks.current[d].gain) {
        decks.current[d].gain!.gain.cancelScheduledValues(0)
        decks.current[d].gain!.gain.setValueAtTime(1, 0)
      }
    })
    setState(s => ({ ...s, isPlaying: false, elapsed: 0 }))
  }, [stopTicker])

  const resume = useCallback(async () => {
    const ctx = ctxRef.current
    if (ctx && ctx.state === 'suspended') {
      await ctx.resume()
    }
  }, [])

  useEffect(() => {
    return () => {
      stopTicker()
      if (crossfadeTimerRef.current) clearTimeout(crossfadeTimerRef.current)
      ctxRef.current?.close().catch(() => {})
    }
  }, [stopTicker])

  return { state, loadDeck, play, crossfadeNow, stop, resume, getElapsed }
}
