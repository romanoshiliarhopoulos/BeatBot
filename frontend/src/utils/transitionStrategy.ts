/**
 * Transition strategy selector.
 *
 * Given feature arrays from the outgoing and incoming tracks at their
 * transition points, selects the most appropriate transition type.
 * Runs entirely client-side using normalised [0,1] feature arrays
 * already present in PredictResponse.
 */
import type { PredictResponse, TransitionConfig } from '../types'

export function computeTransitionConfig(
  outPred: PredictResponse,
  outExitSec: number,
  inPred: PredictResponse,
  inEntrySec: number,
  outTempo: number,
  fadeSecs: number,
): TransitionConfig {
  const outBar = findBarIndex(outPred.bar_times, outExitSec)
  const inBar = findBarIndex(inPred.bar_times, inEntrySec)

  const outEnergy = avg(outPred.energy, outBar)
  const outBass = avg(outPred.bass_energy, outBar)
  const outVocal = avg(outPred.vocal_presence, outBar)
  const outBeat = avg(outPred.beat_strength, outBar)

  const inEnergy = avg(inPred.energy, inBar)
  const inBass = avg(inPred.bass_energy, inBar)
  const inVocal = avg(inPred.vocal_presence, inBar)
  const inBeat = avg(inPred.beat_strength, inBar)

  const beatTime = 60 / Math.max(outTempo, 60)

  // 1. EQ Bass Swap: both tracks have strong kicks
  if (outBass > 0.5 && inBass > 0.5 && outBeat > 0.4 && inBeat > 0.4) {
    return {
      type: 'eq_swap',
      curve: 'equal_power',
      fadeSecs,
      bassSwapAt: 0.3,
    }
  }

  // 3. Filter Sweep: outgoing has vocals
  if (outVocal > 0.5) {
    return {
      type: 'filter_sweep',
      curve: 'equal_power',
      fadeSecs,
      filterStartHz: 20000,
      filterEndHz: 200,
    }
  }

  // 4. Echo Out: strong rhythmic content at exit
  if (outBeat > 0.6 && outEnergy > 0.5) {
    return {
      type: 'echo_out',
      curve: 'equal_power',
      fadeSecs,
      delayTimeSec: round3(beatTime),
      delayFeedback: 0.5,
    }
  }

  // 5. Harmonic Blend: both tracks low energy, no vocals
  if (outEnergy < 0.35 && inEnergy < 0.35 && outVocal < 0.3 && inVocal < 0.3) {
    return {
      type: 'harmonic_blend',
      curve: 'equal_power',
      fadeSecs: Math.max(fadeSecs, 10),
    }
  }

  // 6. Default: equal-power crossfade
  return { type: 'crossfade', curve: 'equal_power', fadeSecs }
}

// ── helpers ──────────────────────────────────────────────────────────────

function findBarIndex(barTimes: number[] | undefined, sec: number): number {
  if (!barTimes?.length) return 0
  let best = 0
  let bestDist = Math.abs(barTimes[0] - sec)
  for (let i = 1; i < barTimes.length; i++) {
    const d = Math.abs(barTimes[i] - sec)
    if (d < bestDist) { bestDist = d; best = i }
  }
  return best
}

function avg(arr: number[] | undefined, center: number, window = 4): number {
  if (!arr?.length) return 0
  let sum = 0, count = 0
  const lo = Math.max(0, center - window)
  const hi = Math.min(arr.length, center + window)
  for (let i = lo; i < hi; i++) { sum += arr[i]; count++ }
  return count > 0 ? sum / count : 0
}

function round3(n: number): number { return Math.round(n * 1000) / 1000 }
