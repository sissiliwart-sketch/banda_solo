import workletUrl from './worklets/capture.worklet.js?url'
import limiterUrl from './worklets/limiter.worklet.ts?worker&url'

export const SAMPLE_RATE = 48000

let ctx: AudioContext | null = null
let workletLoaded: Promise<void> | null = null
let masterIn: GainNode | null = null
let outputBus: GainNode | null = null
let limiterReady = false

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
  if (!workletLoaded) {
    workletLoaded = Promise.all([
      c.audioWorklet.addModule(workletUrl),
      c.audioWorklet.addModule(limiterUrl).then(
        () => {
          limiterReady = true
        },
        (err) => console.warn('[audio] limiter unavailable', err),
      ),
    ]).then(() => undefined)
  }
  await workletLoaded
  return c
}

/** Starts audio output; call from a tap/click (browser autoplay policy). */
export async function resumeAudio(): Promise<void> {
  const c = getAudioContext()
  if (c.state !== 'running') await c.resume()
}

/**
 * Final output: everything audible (mix, metronome, calibration beeps) ends here and goes through
 * the look-ahead limiter, so loud mixes never clip. Because calibration beeps take the same path,
 * the limiter's 5 ms latency is part of the measured round trip and sync stays exact.
 */
export function getOutputBus(): GainNode {
  const c = getAudioContext()
  if (!outputBus) {
    outputBus = c.createGain()
    if (limiterReady) {
      const limiter = new AudioWorkletNode(c, 'banda-solo-limiter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      })
      outputBus.connect(limiter).connect(c.destination)
    } else {
      outputBus.connect(c.destination)
    }
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

/** Mix bus for all tracks (unity gain; peaks are handled by the limiter on the output bus). */
export function getMasterInput(): GainNode {
  const c = getAudioContext()
  if (!masterIn) {
    masterIn = c.createGain()
    masterIn.connect(getOutputBus())
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
