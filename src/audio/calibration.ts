import type { Capture } from './capture'
import { findTemplate, makeChirp, median } from './dsp'
import { getOutputBus, reportedOutputLatency, sleep } from './context'

export interface Calibration {
  /** Round-trip latency in milliseconds (speaker/headphone → mic → context). */
  rtlMs: number
  /** Reported output latency at calibration time, used to adapt if the output route changes. */
  outputLatencyMs: number
  spreadMs: number
  detections: number
  date: string
}

export interface CalibrationOutcome {
  ok: boolean
  calibration?: Calibration
  message: string
}

const CHIRPS = 8
const SPACING = 0.7
const LEAD = 0.5
const SEARCH = 0.6

export async function runLatencyCalibration(capture: Capture): Promise<CalibrationOutcome> {
  const ctx = capture.ctx
  if (!capture.hasInput) return { ok: false, message: 'Nenhum microfone ativo.' }
  const sr = ctx.sampleRate
  const chirp = makeChirp(sr)
  const buf = ctx.createBuffer(1, chirp.length, sr)
  buf.copyToChannel(chirp, 0)
  const out = ctx.createGain()
  out.gain.value = 1
  out.connect(getOutputBus())

  await capture.start(LEAD + CHIRPS * SPACING + 2, 1)
  const base = ctx.currentTime + LEAD
  const times: number[] = []
  for (let i = 0; i < CHIRPS; i++) {
    const t = Math.round((base + i * SPACING) * sr) / sr
    const node = ctx.createBufferSource()
    node.buffer = buf
    node.connect(out)
    node.start(t)
    times.push(t)
  }
  const endAt = times[times.length - 1] + SEARCH + 0.2
  while (ctx.currentTime < endAt) await sleep(50)
  const data = await capture.stop()
  out.disconnect()

  const sig = data.head
  const rtls: number[] = []
  for (const t of times) {
    const expected = Math.round(t * sr) - data.startFrame
    if (expected < 0) continue
    const win = sig.subarray(expected, Math.min(sig.length, expected + Math.round(SEARCH * sr) + chirp.length))
    if (win.length < chirp.length * 2) continue
    const m = findTemplate(win, chirp)
    if (m.score < 0.35) continue
    // Round trip = context frame where the chirp came back in - context time it was played at.
    const detectedFrame = data.startFrame + expected + m.index
    rtls.push(detectedFrame / sr - t)
  }
  if (rtls.length < 5) {
    return {
      ok: false,
      message:
        rtls.length === 0
          ? 'Não ouvi os bipes. Aumente o volume e aproxime o fone (ou o alto-falante) do microfone.'
          : 'Ouvi poucos bipes com clareza. Tente num lugar mais silencioso, com o volume mais alto.',
    }
  }
  const med = median(rtls)
  const inliers = rtls.filter((x) => Math.abs(x - med) < 0.0015)
  if (inliers.length < 5) {
    return { ok: false, message: 'As medições variaram muito. Tente de novo sem mexer no tablet.' }
  }
  const mean = inliers.reduce((a, b) => a + b, 0) / inliers.length
  const spread = Math.max(...inliers) - Math.min(...inliers)
  return {
    ok: true,
    message: `Latência medida: ${(mean * 1000).toFixed(1)} ms`,
    calibration: {
      rtlMs: mean * 1000,
      outputLatencyMs: reportedOutputLatency(ctx) * 1000,
      spreadMs: spread * 1000,
      detections: inliers.length,
      date: new Date().toISOString(),
    },
  }
}

const KEY = 'bs.calibration.v1'

function loadAll(): Record<string, Calibration> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, Calibration>
  } catch {
    return {}
  }
}

export function loadCalibration(micKey: string): Calibration | null {
  return loadAll()[micKey] ?? null
}

export function saveCalibration(micKey: string, c: Calibration): void {
  try {
    const all = loadAll()
    all[micKey] = c
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* storage unavailable */
  }
}

/**
 * Round-trip latency to apply to a new take. Uses the calibration for this microphone and adapts
 * to output-route changes the browser reports (e.g. switching to Bluetooth headphones).
 */
export function effectiveRtlSec(ctx: AudioContext, micKey: string): { rtl: number; calibrated: boolean } {
  const c = loadCalibration(micKey)
  const outNow = reportedOutputLatency(ctx)
  if (c) {
    const delta = Math.max(-0.05, Math.min(0.4, outNow - c.outputLatencyMs / 1000))
    return { rtl: c.rtlMs / 1000 + delta, calibrated: true }
  }
  // Uncalibrated guess: reported output latency plus a typical Android input path.
  return { rtl: outNow + 0.02, calibrated: false }
}
