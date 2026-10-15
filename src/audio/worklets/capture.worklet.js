// AudioWorklet that captures the microphone sample-accurately on the AudioContext timeline.
// Every batch of samples is posted with the absolute context frame of its first sample,
// which is what lets Banda Solo place a new take exactly against the playback clock.

const BATCH = 4096

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.recording = false
    this.buf = new Float32Array(BATCH)
    this.len = 0
    this.batchStart = 0
    this.peak = 0
    this.sumSq = 0
    this.meterFrames = 0
    this.port.onmessage = (e) => {
      const msg = e.data
      if (msg.type === 'start') {
        this.recording = true
        this.len = 0
        this.port.postMessage({ type: 'started', frame: currentFrame, id: msg.id })
      } else if (msg.type === 'stop') {
        this.flush()
        this.recording = false
        this.port.postMessage({ type: 'stopped', frame: currentFrame, id: msg.id })
      }
    }
  }

  flush() {
    if (this.len === 0) return
    const out = this.buf.slice(0, this.len)
    this.port.postMessage({ type: 'data', frame: this.batchStart, samples: out }, [out.buffer])
    this.len = 0
  }

  process(inputs) {
    const input = inputs[0]
    const chans = input ? input.length : 0
    const n = chans > 0 ? input[0].length : 128

    if (this.recording && this.len === 0) this.batchStart = currentFrame

    for (let i = 0; i < n; i++) {
      let s = 0
      if (chans === 1) s = input[0][i]
      else if (chans > 1) {
        for (let c = 0; c < chans; c++) s += input[c][i]
        s /= chans
      }
      const a = s < 0 ? -s : s
      if (a > this.peak) this.peak = a
      this.sumSq += s * s
      if (this.recording) this.buf[this.len++] = s
    }

    if (this.recording && this.len + 128 > BATCH) this.flush()

    this.meterFrames += n
    if (this.meterFrames >= 2048) {
      this.port.postMessage({ type: 'level', peak: this.peak, rms: Math.sqrt(this.sumSq / this.meterFrames) })
      this.peak = 0
      this.sumSq = 0
      this.meterFrames = 0
    }
    return true
  }
}

registerProcessor('banda-solo-capture', CaptureProcessor)
