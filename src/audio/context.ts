import workletUrl from './worklets/capture.worklet.js?url'
import { makeSoftClipCurve } from './dsp'

export const SAMPLE_RATE = 48000

let ctx: AudioContext | null = null
let workletLoaded: Promise<void> | null = null
let masterIn: GainNode | null = null
let outputBus: GainNode | null = null

export function getAudioContext(): AudioContext {
  if (!ctx) {
    try {
      ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: SAMPLE_RATE })
    } catch {
      ctx = new AudioContext({ latencyHint: 'interactive' })
    }
  }
  return ctx
}

/** Creates the context and loads the capture worklet (works before any user gesture). */
export async function ensureAudio(): Promise<AudioContext> {
  const c = getAudioContext()
  if (!workletLoaded) workletLoaded = c.audioWorklet.addModule(workletUrl)
  await workletLoaded
  return c
}

/** Starts audio output; call from a tap/click (browser autoplay policy). */
export async function resumeAudio(): Promise<void> {
  const c = getAudioContext()
  if (c.state !== 'running') await c.resume()
}

/** Final output: everything audible (mix, metronome, calibration beeps) ends here. */
export function getOutputBus(): GainNode {
  const c = getAudioContext()
  if (!outputBus) {
    outputBus = c.createGain()
    outputBus.connect(c.destination)
  }
  return outputBus
}

/**
 * Digital loopback of the output as a microphone track — used by automated tests to simulate a
 * musician who plays exactly what they hear, which validates the whole sync chain end to end.
 */
export function loopbackAudioTrack(): MediaStreamTrack {
  const c = getAudioContext()
  const dest = c.createMediaStreamDestination()
  getOutputBus().connect(dest)
  return dest.stream.getAudioTracks()[0]
}

/**
 * Master bus: everything audible goes through here. A stateless soft clipper keeps the mix
 * of up to eight tracks from clipping harshly (the export applies the same curve).
 */
export function getMasterInput(): GainNode {
  const c = getAudioContext()
  if (!masterIn) {
    masterIn = c.createGain()
    const pre = c.createGain()
    pre.gain.value = 0.5
    const shaper = c.createWaveShaper()
    shaper.curve = makeSoftClipCurve(2)
    shaper.oversample = 'none'
    masterIn.connect(pre).connect(shaper).connect(getOutputBus())
  }
  return masterIn
}

/** Context time of the audio that is reaching the speakers/headphones right now. */
export function audibleContextTime(c: AudioContext): number {
  const ts = c.getOutputTimestamp?.()
  if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
    return ts.contextTime + (performance.now() - ts.performanceTime) / 1000
  }
  return c.currentTime - (c.outputLatency || 0) - (c.baseLatency || 0)
}

export function reportedOutputLatency(c: AudioContext): number {
  return (c.outputLatency || 0) + (c.baseLatency || 0)
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
