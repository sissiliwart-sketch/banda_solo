import { findTemplate, loudestWindow, resampleLinear } from './dsp'

export interface DecodedSegment {
  /** Mono samples. */
  samples: Float32Array
  sampleRate: number
  /** File time (seconds) of samples[0]. */
  startTime: number
}

export type DecodeFn = (t0: number, t1: number) => Promise<DecodedSegment | null>

export interface CaptureData {
  sampleRate: number
  /** Absolute AudioContext frame of head[0]. */
  startFrame: number
  /** Total frames captured during the take. */
  totalFrames: number
  /** First part of the take (mono). */
  head: Float32Array
  /** Last part of the take (mono); tail[0] is at absolute frame tailStartFrame. */
  tail: Float32Array
  tailStartFrame: number
  /** Device file with the whole take as 16-bit mono PCM (sample 0 = startFrame), when requested. */
  pcmPath?: string
}

export interface AlignResult {
  /** Absolute AudioContext frame that corresponds to file time 0. */
  fileStartFrame: number
  quality: 'exact' | 'estimated'
  score: number
  /** Clock drift between the recorded file and the context clock, in ppm (positive: file runs long). */
  driftPpm: number | null
}

const WINDOW_SEC = 1.5
const MIN_LAG_SEC = -0.5
const MAX_LAG_SEC = 2.5
const GOOD_SCORE = 0.5
const MIN_SCORE = 0.3

/**
 * Locates where the recorded media file starts on the AudioContext timeline by matching the
 * file's own audio against the sample-accurate capture taken by the AudioWorklet.
 *
 * `lag` = fileStartFrame - capture.startFrame (MediaRecorder starts a little after the worklet).
 */
async function matchAt(
  segment: Float32Array,
  /** Position of segment[0] relative to the start of the capture, in frames. */
  segmentIndex: number,
  sampleRate: number,
  decode: DecodeFn,
): Promise<{ lag: number; score: number } | null> {
  const len = segment.length
  // file time of segment[0] is (segmentIndex - lag) / sr, with lag in [MIN_LAG, MAX_LAG]
  const t0 = Math.max(0, (segmentIndex - MAX_LAG_SEC * sampleRate) / sampleRate - 0.05)
  const t1 = (segmentIndex - MIN_LAG_SEC * sampleRate + len) / sampleRate + 0.05
  const dec = await decode(t0, t1)
  if (!dec || dec.samples.length < len) return null
  const fileSeg = resampleLinear(dec.samples, dec.sampleRate, sampleRate)
  if (fileSeg.length < len) return null
  const { index, score } = findTemplate(fileSeg, segment)
  // segment[0] == file time dec.startTime + index / sr
  const fileFrameOfSegment = dec.startTime * sampleRate + index
  return { lag: segmentIndex - fileFrameOfSegment, score }
}

export async function alignFileToCapture(capture: CaptureData, decode: DecodeFn, fallbackLagFrames: number): Promise<AlignResult> {
  const sr = capture.sampleRate
  const len = Math.round(WINDOW_SEC * sr)
  const fallback: AlignResult = {
    fileStartFrame: capture.startFrame + fallbackLagFrames,
    quality: 'estimated',
    score: 0,
    driftPpm: null,
  }
  if (capture.head.length < len + Math.round(0.6 * sr)) return fallback

  // Window must sit late enough in the take that the file (which starts up to MAX_LAG later) contains it.
  const from = Math.min(Math.round(MAX_LAG_SEC * sr), capture.head.length - len)
  // Search the first 30 s only, so long takes leave room for a second match near the end.
  const to = Math.max(from, Math.min(capture.head.length - len, Math.round(30 * sr)))
  const pick = loudestWindow(capture.head, len, from, to, Math.round(0.25 * sr))
  const seg = capture.head.subarray(pick.start, pick.start + len)
  const head = await matchAt(seg, pick.start, sr, decode).catch(() => null)
  if (!head || head.score < MIN_SCORE) return fallback

  let driftPpm: number | null = null
  let lag = head.lag
  let score = head.score
  // Second match near the end of long takes: verifies the result and measures clock drift.
  const tailOffset = capture.tailStartFrame - capture.startFrame
  if (capture.tail.length >= len * 2 && tailOffset - pick.start > 20 * sr) {
    const tp = loudestWindow(capture.tail, len, 0, capture.tail.length - len, Math.round(0.25 * sr))
    const tseg = capture.tail.subarray(tp.start, tp.start + len)
    const tail = await matchAt(tseg, tailOffset + tp.start, sr, decode).catch(() => null)
    if (tail && tail.score >= MIN_SCORE) {
      const dist = tailOffset + tp.start - pick.start
      // lag grows when the file has fewer samples than the context for the same span
      driftPpm = ((head.lag - tail.lag) / dist) * 1e6
      if (tail.score > score && Math.abs(driftPpm) < 5) {
        lag = tail.lag
        score = tail.score
      }
    }
  }

  return {
    fileStartFrame: capture.startFrame + lag,
    quality: score >= GOOD_SCORE ? 'exact' : 'estimated',
    score,
    driftPpm,
  }
}

/**
 * File time (seconds) that lines up with timeline position 0.
 *
 * t0Ctx:     context time at which timeline position 0 was played back.
 * rtlSec:    round-trip latency (output → ear → instrument → mic → context).
 */
export function computeStartOffset(fileStartFrame: number, sampleRate: number, t0Ctx: number, rtlSec: number): number {
  return t0Ctx + rtlSec - fileStartFrame / sampleRate
}
