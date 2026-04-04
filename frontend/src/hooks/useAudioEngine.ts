/**
 * useAudioEngine — Web Audio API two-deck transition engine.
 *
 * Per-deck audio graph:
 *   Source → LowShelf → Peaking → HighShelf → SweepFilter → MasterGain → destination
 *                                                              └→ Delay → DelayWet → destination
 *                                                                   └→ Feedback ─┘
 *
 * All filter/effect nodes default to passthrough. They activate only when
 * a non-default transition type is selected.
 */
import { useRef, useState, useCallback, useEffect } from 'react'
import type { TransitionConfig, CurveType } from '../types'

export type { TransitionConfig } from '../types'
export type ActiveDeck = 'A' | 'B'

// ── Gain curve keypoints (t → value) ────────────────────────────────────

interface Keypoint { t: number; out: number; in: number }

const EQUAL_POWER: Keypoint[] = [
  { t: 0,    out: 1,     in: 0     },
  { t: 0.25, out: 0.924, in: 0.383 },
  { t: 0.5,  out: 0.707, in: 0.707 },
  { t: 0.75, out: 0.383, in: 0.924 },
  { t: 1,    out: 0,     in: 1     },
]

const S_CURVE: Keypoint[] = [
  { t: 0,    out: 1,     in: 0     },
  { t: 0.25, out: 0.844, in: 0.156 },
  { t: 0.5,  out: 0.5,   in: 0.5   },
  { t: 0.75, out: 0.156, in: 0.844 },
  { t: 1,    out: 0,     in: 1     },
]

const LINEAR: Keypoint[] = [
  { t: 0, out: 1, in: 0 },
  { t: 1, out: 0, in: 1 },
]

function keypoints(curve: CurveType): Keypoint[] {
  return curve === 's_curve' ? S_CURVE : curve === 'linear' ? LINEAR : EQUAL_POWER
}

function scheduleFadeOut(p: AudioParam, t0: number, dur: number, curve: CurveType, start = 1) {
  p.cancelScheduledValues(t0)
  p.setValueAtTime(start, t0)
  for (const k of keypoints(curve)) {
    if (k.t > 0) p.linearRampToValueAtTime(start * k.out, t0 + dur * k.t)
  }
}

function scheduleFadeIn(p: AudioParam, t0: number, dur: number, curve: CurveType, end = 1) {
  p.cancelScheduledValues(t0)
  p.setValueAtTime(0, t0)
  for (const k of keypoints(curve)) {
    if (k.t > 0) p.linearRampToValueAtTime(end * k.in, t0 + dur * k.t)
  }
}

// ── Deck reference ──────────────────────────────────────────────────────

interface DeckRef {
  trackId: string | null
  buffer: AudioBuffer | null
  source: AudioBufferSourceNode | null
  // 3-band EQ (chained in series: source → low → peak → high → sweep → master)
  lowShelf: BiquadFilterNode | null
  peaking: BiquadFilterNode | null
  highShelf: BiquadFilterNode | null
  sweepFilter: BiquadFilterNode | null
  masterGain: GainNode | null
  // Delay / echo effect
  delayNode: DelayNode | null
  delayFeedback: GainNode | null
  delayWet: GainNode | null
  // Timing
  startedAtCtxTime: number
  startedAtOffset: number
}

function emptyDeck(): DeckRef {
  return {
    trackId: null, buffer: null, source: null,
    lowShelf: null, peaking: null, highShelf: null,
    sweepFilter: null, masterGain: null,
    delayNode: null, delayFeedback: null, delayWet: null,
    startedAtCtxTime: 0, startedAtOffset: 0,
  }
}

// ── Public types ────────────────────────────────────────────────────────

export interface AudioEngineState {
  isPlaying: boolean
  activeDeck: ActiveDeck
  elapsed: number
  loadingA: boolean
  loadingB: boolean
}

export interface AudioEngine {
  state: AudioEngineState
  loadDeck: (deck: ActiveDeck, trackId: string, file?: File) => Promise<void>
  play: (entrySec: number, exitSec: number, fadeSecs: number) => void
  crossfadeNow: (entrySec: number, fadeSecs: number, transition?: TransitionConfig) => void
  rescheduleTransition: (exitSec: number, fadeSecs: number) => void
  stop: () => void
  resume: () => Promise<void>
  getElapsed: () => number
}

// ── Hook ────────────────────────────────────────────────────────────────

export function useAudioEngine(): AudioEngine {
  const ctxRef = useRef<AudioContext | null>(null)
  const decks = useRef<{ A: DeckRef; B: DeckRef }>({ A: emptyDeck(), B: emptyDeck() })
  const activeDeckRef = useRef<ActiveDeck>('A')
  const crossfadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const transitionInProgressRef = useRef<{ endTime: number } | null>(null)

  const [state, setState] = useState<AudioEngineState>({
    isPlaying: false, activeDeck: 'A', elapsed: 0, loadingA: false, loadingB: false,
  })

  // ── core helpers ─────────────────────────────────────────────────────

  const getCtx = useCallback((): AudioContext => {
    if (!ctxRef.current) ctxRef.current = new AudioContext()
    return ctxRef.current
  }, [])

  const getElapsed = useCallback((): number => {
    const ctx = ctxRef.current
    if (!ctx) return 0
    const a = decks.current[activeDeckRef.current]
    if (!a.source) return 0
    return Math.max(0, (ctx.currentTime - a.startedAtCtxTime) + a.startedAtOffset)
  }, [])

  const startTicker = useCallback(() => {
    if (tickerRef.current) return
    tickerRef.current = setInterval(() => {
      setState(s => ({ ...s, elapsed: getElapsed() }))
    }, 250)
  }, [getElapsed])

  const stopTicker = useCallback(() => {
    if (tickerRef.current) { clearInterval(tickerRef.current); tickerRef.current = null }
  }, [])

  // ── build per-deck audio graph ───────────────────────────────────────

  const _ensureGraph = useCallback((deck: ActiveDeck) => {
    const ctx = getCtx()
    const d = decks.current[deck]
    if (d.masterGain) return // already built

    const low = ctx.createBiquadFilter()
    low.type = 'lowshelf'; low.frequency.value = 300; low.gain.value = 0

    const peak = ctx.createBiquadFilter()
    peak.type = 'peaking'; peak.frequency.value = 1000; peak.Q.value = 0.7; peak.gain.value = 0

    const high = ctx.createBiquadFilter()
    high.type = 'highshelf'; high.frequency.value = 3000; high.gain.value = 0

    const sweep = ctx.createBiquadFilter()
    sweep.type = 'lowpass'; sweep.frequency.value = 20000; sweep.Q.value = 0.7

    const master = ctx.createGain()
    master.gain.value = 1

    const delay = ctx.createDelay(2.0)
    delay.delayTime.value = 0.5
    const fb = ctx.createGain(); fb.gain.value = 0
    const wet = ctx.createGain(); wet.gain.value = 0

    // EQ chain → sweep → master → destination
    low.connect(peak); peak.connect(high); high.connect(sweep)
    sweep.connect(master); master.connect(ctx.destination)

    // Delay path: master → delay → wet → destination  +  delay → fb → delay
    master.connect(delay); delay.connect(wet); wet.connect(ctx.destination)
    delay.connect(fb); fb.connect(delay)

    Object.assign(d, {
      lowShelf: low, peaking: peak, highShelf: high,
      sweepFilter: sweep, masterGain: master,
      delayNode: delay, delayFeedback: fb, delayWet: wet,
    })
  }, [getCtx])

  // ── reset EQ / effects to passthrough ────────────────────────────────

  const _reset = useCallback((deck: ActiveDeck) => {
    const ctx = ctxRef.current
    if (!ctx) return
    const d = decks.current[deck]
    const now = ctx.currentTime
    
    // Aggressively clear all scheduled parameter changes
    const clearParam = (p: AudioParam | undefined) => {
      if (!p) return
      p.cancelScheduledValues(now)
      p.setValueAtTime(0, now)
    }
    
    clearParam(d.lowShelf?.gain)
    clearParam(d.peaking?.gain)
    clearParam(d.highShelf?.gain)
    clearParam(d.delayFeedback?.gain)
    clearParam(d.delayWet?.gain)
    
    // Also clear frequency parameters
    if (d.sweepFilter) {
      d.sweepFilter.frequency.cancelScheduledValues(now)
      d.sweepFilter.frequency.setValueAtTime(20000, now)
    }
    
    if (d.delayNode) {
      d.delayNode.delayTime.cancelScheduledValues(now)
      d.delayNode.delayTime.setValueAtTime(0.5, now)
    }
  }, [])

  // ── load deck ────────────────────────────────────────────────────────

  const loadDeck = useCallback(async (deck: ActiveDeck, trackId: string, file?: File) => {
    setState(s => deck === 'A' ? { ...s, loadingA: true } : { ...s, loadingB: true })
    const ctx = getCtx()
    _ensureGraph(deck)
    try {
      if (!file) {
        console.warn(`[AudioEngine] No local file for deck ${deck} track "${trackId}"`)
        return
      }
      const audioBuf = await ctx.decodeAudioData(await file.arrayBuffer())
      decks.current[deck].buffer = audioBuf
      decks.current[deck].trackId = trackId
    } catch (err) {
      console.error(`[AudioEngine] Failed to load deck ${deck}:`, err)
    } finally {
      setState(s => deck === 'A' ? { ...s, loadingA: false } : { ...s, loadingB: false })
    }
  }, [getCtx, _ensureGraph])

  // ── start playback on a deck ─────────────────────────────────────────

  const _startDeck = useCallback((deck: ActiveDeck, offsetSec: number, when?: number) => {
    const ctx = getCtx()
    const d = decks.current[deck]
    if (!d.buffer) return
    if (!d.lowShelf) _ensureGraph(deck)

    try { d.source?.stop() } catch { /* already stopped */ }

    const src = ctx.createBufferSource()
    src.buffer = d.buffer
    src.connect(d.lowShelf!)
    src.start(when ?? 0, Math.max(0, offsetSec))

    d.source = src
    d.startedAtCtxTime = when ?? ctx.currentTime
    d.startedAtOffset = offsetSec
  }, [getCtx, _ensureGraph])

  // ── execute transition ───────────────────────────────────────────────

  const _exec = useCallback((outDeck: ActiveDeck, inDeck: ActiveDeck, cfg: TransitionConfig) => {
    const ctx = getCtx()
    const now = ctx.currentTime
    const o = decks.current[outDeck]
    const i = decks.current[inDeck]
    const { type, curve, fadeSecs } = cfg

    // Track transition end time for guard
    transitionInProgressRef.current = { endTime: now + fadeSecs }

    // Log transition data
    const transitionData = {
      timestamp: new Date().toISOString(),
      transitionType: type,
      durationSec: fadeSecs,
      curveType: curve,
      outgoingDeck: outDeck,
      outgoingTrack: o.trackId,
      incomingDeck: inDeck,
      incomingTrack: i.trackId,
      ctxTime: now,
      ...cfg, // Include all config parameters (bassSwapAt, filterStartHz, delayTimeSec, etc.)
    }
    console.log('[AudioEngine] TRANSITION', transitionData)

    _reset(outDeck)
    _reset(inDeck)

    // If incoming deck has no source, this transition will break. Log a warning.
    let effectiveType = type
    if (!i.source) {
      console.warn('[AudioEngine] TRANSITION_WARNING: Incoming deck has no source loaded. Will fade out current track only.', {
        inDeck,
        inTrack: i.trackId,
        outDeck,
        outTrack: o.trackId,
      })
      // Fall back to a simple fadeout on outgoing deck only
      effectiveType = 'crossfade'
    }

    switch (effectiveType) {
      // ── EQ Bass Swap ─────────────────────────────────────────────────
      case 'eq_swap': {
        if (o.masterGain) scheduleFadeOut(o.masterGain.gain, now, fadeSecs, curve)
        if (i.source && i.masterGain) scheduleFadeIn(i.masterGain.gain, now, fadeSecs, curve)

        // Smooth bass swap: ramp out/in over the middle third of the fade
        const swapCenter = fadeSecs * (cfg.bassSwapAt ?? 0.3)
        const rampDur = fadeSecs * 0.3 // 30% of fade for the bass ramp
        const swapStart = now + Math.max(0, swapCenter - rampDur / 2)
        const swapEnd = now + swapCenter + rampDur / 2
        if (o.lowShelf) {
          o.lowShelf.gain.setValueAtTime(0, now)
          o.lowShelf.gain.setValueAtTime(0, swapStart)
          o.lowShelf.gain.linearRampToValueAtTime(-30, swapEnd)
        }
        if (i.source && i.lowShelf) {
          i.lowShelf.gain.setValueAtTime(-30, now)
          i.lowShelf.gain.setValueAtTime(-30, swapStart)
          i.lowShelf.gain.linearRampToValueAtTime(0, swapEnd)
        }
        break
      }

      // ── Filter Sweep ─────────────────────────────────────────────────
      case 'filter_sweep': {
        if (o.masterGain) scheduleFadeOut(o.masterGain.gain, now, fadeSecs, curve)
        if (i.source && i.masterGain) scheduleFadeIn(i.masterGain.gain, now, fadeSecs, curve)

        if (o.sweepFilter) {
          o.sweepFilter.frequency.setValueAtTime(cfg.filterStartHz ?? 20000, now)
          o.sweepFilter.frequency.exponentialRampToValueAtTime(
            Math.max(cfg.filterEndHz ?? 200, 20), now + fadeSecs,
          )
        }
        break
      }

      // ── Echo / Delay Fade-Out ────────────────────────────────────────
      case 'echo_out': {
        if (o.masterGain) scheduleFadeOut(o.masterGain.gain, now, fadeSecs, curve)
        if (i.source && i.masterGain) scheduleFadeIn(i.masterGain.gain, now, fadeSecs, curve)

        if (o.delayNode) o.delayNode.delayTime.setValueAtTime(cfg.delayTimeSec ?? 0.5, now)
        if (o.delayFeedback) {
          o.delayFeedback.gain.setValueAtTime(0, now)
          o.delayFeedback.gain.linearRampToValueAtTime(cfg.delayFeedback ?? 0.5, now + fadeSecs * 0.3)
        }
        if (o.delayWet) {
          o.delayWet.gain.setValueAtTime(0, now)
          o.delayWet.gain.linearRampToValueAtTime(0.7, now + fadeSecs * 0.5)
          o.delayWet.gain.linearRampToValueAtTime(0, now + fadeSecs)
        }
        break
      }

      
      // ── Harmonic Blend / Default Crossfade ───────────────────────────
      case 'harmonic_blend':
      case 'crossfade':
      default: {
        if (o.masterGain) scheduleFadeOut(o.masterGain.gain, now, fadeSecs, curve, o.masterGain.gain.value)
        if (i.source && i.masterGain) scheduleFadeIn(i.masterGain.gain, now, fadeSecs, curve)
        break
      }
    }
  }, [getCtx, _reset])

  // ── public: rescheduleTransition ─────────────────────────────────────

  const rescheduleTransition = useCallback((exitSec: number, fadeSecs: number) => {
    const ctx = ctxRef.current
    if (!ctx || !state.isPlaying) return
    const deck = activeDeckRef.current
    const d = decks.current[deck]
    if (!d.source) return

    if (crossfadeTimerRef.current) clearTimeout(crossfadeTimerRef.current)

    const elapsed = (ctx.currentTime - d.startedAtCtxTime) + d.startedAtOffset
    const remainMs = Math.max(0, (exitSec - elapsed) * 1000)

    // Skip if transition is already past its exit time
    if (remainMs === 0) {
      console.warn('[AudioEngine] TRANSITION_SKIPPED: Exit time already passed', {
        timestamp: new Date().toISOString(),
        exitSec,
        elapsed,
        fadeSecs,
      })
      transitionInProgressRef.current = null
      return
    }

    console.log('[AudioEngine] TRANSITION_RESCHEDULED', {
      timestamp: new Date().toISOString(),
      exitSec,
      fadeSecs,
      elapsed,
      remainingMs: remainMs,
      activeDeck: deck,
      trackId: d.trackId,
    })

    crossfadeTimerRef.current = setTimeout(() => {
      const g = decks.current[deck].masterGain
      if (!g) return
      transitionInProgressRef.current = null // Clear guard when auto-fade completes
      scheduleFadeOut(g.gain, ctx.currentTime, fadeSecs, 'equal_power', g.gain.value)
    }, remainMs)
  }, [state.isPlaying])

  // ── public: play ─────────────────────────────────────────────────────

  const play = useCallback((entrySec: number, exitSec: number, fadeSecs: number) => {
    const ctx = getCtx()
    const deck = activeDeckRef.current
    _ensureGraph(deck)
    const d = decks.current[deck]
    if (!d.buffer) { console.warn('[AudioEngine] play(): empty buffer'); return }

    _reset(deck)
    if (d.masterGain) {
      d.masterGain.gain.cancelScheduledValues(ctx.currentTime)
      d.masterGain.gain.setValueAtTime(1, ctx.currentTime)
    }

    _startDeck(deck, entrySec)
    setState(s => ({ ...s, isPlaying: true, activeDeck: deck }))
    startTicker()

    // backup auto-fade (DJEnvironment also triggers crossfadeNow)
    const delayMs = Math.max(0, (exitSec - entrySec) * 1000)
    if (crossfadeTimerRef.current) clearTimeout(crossfadeTimerRef.current)
    crossfadeTimerRef.current = setTimeout(() => {
      const g = decks.current[deck].masterGain
      if (!g) return
      scheduleFadeOut(g.gain, ctx.currentTime, fadeSecs, 'equal_power', g.gain.value)
    }, delayMs)
  }, [getCtx, _ensureGraph, _reset, _startDeck, startTicker])

  // ── public: crossfadeNow ─────────────────────────────────────────────

  const crossfadeNow = useCallback((
    entrySec: number,
    fadeSecs: number,
    transition?: TransitionConfig,
  ) => {
    const ctx = getCtx()
    const now = ctx.currentTime
    const outDeck = activeDeckRef.current
    const inDeck: ActiveDeck = outDeck === 'A' ? 'B' : 'A'

    const cfg: TransitionConfig = transition ?? { type: 'crossfade', curve: 'equal_power', fadeSecs }

    console.log('[AudioEngine] CROSSFADE_INITIATED', {
      timestamp: new Date().toISOString(),
      entrySec,
      fadeSecs,
      outgoingDeck: outDeck,
      incomingDeck: inDeck,
      transitionType: cfg.type,
      curveType: cfg.curve,
    })

    if (crossfadeTimerRef.current) {
      clearTimeout(crossfadeTimerRef.current)
      crossfadeTimerRef.current = null
    }

    _ensureGraph(outDeck)
    _ensureGraph(inDeck)

    _startDeck(inDeck, entrySec)

    _exec(outDeck, inDeck, cfg)

    activeDeckRef.current = inDeck
    setState(s => ({ ...s, activeDeck: inDeck, isPlaying: true }))
  }, [getCtx, _ensureGraph, _startDeck, _exec])

  // ── public: stop ─────────────────────────────────────────────────────

  const stop = useCallback(() => {
    if (crossfadeTimerRef.current) clearTimeout(crossfadeTimerRef.current)
    transitionInProgressRef.current = null
    stopTicker()
    ;(['A', 'B'] as ActiveDeck[]).forEach(dk => {
      try { decks.current[dk].source?.stop() } catch { /* ignore */ }
      decks.current[dk].source = null
      _reset(dk)
      const g = decks.current[dk].masterGain
      if (g) { g.gain.cancelScheduledValues(0); g.gain.setValueAtTime(1, 0) }
    })
    setState(s => ({ ...s, isPlaying: false, elapsed: 0 }))
  }, [stopTicker, _reset])

  // ── public: resume ───────────────────────────────────────────────────

  const resume = useCallback(async () => {
    const ctx = ctxRef.current
    if (ctx && ctx.state === 'suspended') await ctx.resume()
  }, [])

  // ── cleanup ──────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      transitionInProgressRef.current = null
      stopTicker()
      if (crossfadeTimerRef.current) clearTimeout(crossfadeTimerRef.current)
      ctxRef.current?.close().catch(() => {})
    }
  }, [stopTicker])

  return { state, loadDeck, play, crossfadeNow, rescheduleTransition, stop, resume, getElapsed }
}
