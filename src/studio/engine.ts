import type { Input } from 'mediabunny'
import { alignFileToCapture, computeStartOffset, type AlignResult } from '../audio/align'
import { effectiveRtlSec, runLatencyCalibration, saveCalibration, type CalibrationOutcome } from '../audio/calibration'
import { Capture } from '../audio/capture'
import { audibleContextTime, ensureAudio, getMasterInput, getOutputBus } from '../audio/context'
import { Metronome } from '../audio/metronome'
import { MAX_SONG_SECONDS } from '../config'
import { audibleTracks, fileTimeAt, songDuration, type Track } from '../data/types'
import { isFrontFacing, openStream, stopStream, type DeviceSelection } from '../media/devices'
import { decodeAudioSegment, finalizeRecording, openInput, type MediaInfo } from '../media/mediafile'
import { paths, readFile, removeEntry } from '../media/opfs'
import { buildTrackFile } from '../media/trackfile'
import { TakeRecorder } from '../media/recorder'
import { AudioStreamer } from '../media/streamer'
import { Emitter, keepScreenOn, uid } from '../lib/util'

export type TransportState = 'idle' | 'playing' | 'countin' | 'recording' | 'processing'

export interface TakeResult {
  takeId: string
  slot: number
  file: File
  info: MediaInfo
  startOffset: number
  syncQuality: 'exact' | 'estimated'
  syncScore: number
  driftPpm: number | null
  latencyMs: number
  calibrated: boolean
  frontCamera: boolean
}

export interface RecordOptions {
  slot: number
  bpm: number
  beatsPerBar: number
  countInBeats: number
  metronome: boolean
  /** Tracks to silence during this take (e.g. the old version of the slot being re-recorded). */
  exclude?: string[]
}

interface EngineTrack {
  track: Track
  file: File
  input: Input
  streamer: AudioStreamer
  gain: GainNode
  pan: StereoPannerNode
  video: HTMLVideoElement
  url: string
}

interface ActiveTake {
  takeId: string
  slot: number
  recorder: TakeRecorder
  rtl: number
  calibrated: boolean
  t0: number
  frontCamera: boolean
}

type Events = {
  state: TransportState
  level: { peak: number; rms: number }
  tracks: string[]
  error: string
  ended: void
  take: TakeResult
}

function seekVideo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const target = Math.max(0, t)
    if (Math.abs(v.currentTime - target) < 0.01 && v.readyState >= 2) return resolve()
    const done = () => {
      clearTimeout(timer)
      v.removeEventListener('seeked', done)
      resolve()
    }
    const timer = setTimeout(done, 1500)
    v.addEventListener('seeked', done)
    v.currentTime = target
  })
}

/**
 * The studio's audio/video engine. One AudioContext clock drives everything: previous tracks are
 * decoded and scheduled sample-accurately, their videos follow that clock, and each new take is
 * placed on the timeline using the worklet capture + measured round-trip latency.
 */
export class StudioEngine extends Emitter<Events> {
  readonly ctx: AudioContext
  readonly capture: Capture
  readonly metronome: Metronome
  readonly preview: HTMLVideoElement
  private master: GainNode
  private tracks = new Map<string, EngineTrack>()
  private stream: MediaStream | null = null
  private micKey = 'default'
  private _state: TransportState = 'idle'
  private t0 = 0
  private raf = 0
  private take: ActiveTake | null = null
  private quality: DeviceSelection['quality'] = '720p'
  private disposed = false
  private excluded = new Set<string>()

  private constructor(ctx: AudioContext) {
    super()
    this.ctx = ctx
    this.master = getMasterInput()
    this.capture = new Capture(ctx, this.master)
    this.capture.onLevel = (peak, rms) => this.emit('level', { peak, rms })
    this.metronome = new Metronome(ctx, getOutputBus())
    this.preview = document.createElement('video')
    this.preview.muted = true
    this.preview.playsInline = true
    this.preview.autoplay = true
    this.preview.className = 'bs-video'
  }

  static async create(): Promise<StudioEngine> {
    const ctx = await ensureAudio()
    return new StudioEngine(ctx)
  }

  get state(): TransportState {
    return this._state
  }

  private setState(s: TransportState): void {
    this._state = s
    this.emit('state', s)
    void keepScreenOn(s !== 'idle')
  }

  // ---------------------------------------------------------------- devices

  get hasStream(): boolean {
    return this.stream !== null
  }

  get mediaStream(): MediaStream | null {
    return this.stream
  }

  get frontCamera(): boolean {
    return isFrontFacing(this.stream)
  }

  get microphoneKey(): string {
    return this.micKey
  }

  async openDevices(sel: DeviceSelection): Promise<MediaStream> {
    this.closeDevices()
    const stream = await openStream(sel)
    this.stream = stream
    this.quality = sel.quality
    const a = stream.getAudioTracks()[0]
    this.micKey = a ? a.getSettings().deviceId || a.label || 'default' : 'default'
    this.capture.setStream(stream)
    this.preview.srcObject = stream
    this.preview.style.transform = isFrontFacing(stream) ? 'scaleX(-1)' : ''
    void this.preview.play().catch(() => undefined)
    return stream
  }

  closeDevices(): void {
    stopStream(this.stream)
    this.stream = null
    this.capture.setStream(null)
    this.preview.srcObject = null
  }

  setMonitor(on: boolean): void {
    this.capture.setMonitor(on)
  }

  async calibrate(): Promise<CalibrationOutcome> {
    if (this._state !== 'idle') return { ok: false, message: 'Pare a reprodução antes de calibrar.' }
    const res = await runLatencyCalibration(this.capture)
    if (res.ok && res.calibration) saveCalibration(this.micKey, res.calibration)
    return res
  }

  latencyInfo(): { rtlMs: number; calibrated: boolean } {
    const { rtl, calibrated } = effectiveRtlSec(this.ctx, this.micKey)
    return { rtlMs: rtl * 1000, calibrated }
  }

  // ---------------------------------------------------------------- tracks

  trackIds(): string[] {
    return [...this.tracks.keys()]
  }

  videoFor(trackId: string): HTMLVideoElement | null {
    return this.tracks.get(trackId)?.video ?? null
  }

  async setTrack(track: Track, file: File): Promise<void> {
    const existing = this.tracks.get(track.id)
    if (existing && existing.file === file) {
      existing.track = track
      this.applyMix()
      this.applyVideoStyle(existing)
      return
    }
    if (existing) this.removeTrack(track.id)
    const input = openInput(file)
    const gain = this.ctx.createGain()
    const pan = this.ctx.createStereoPanner()
    gain.connect(pan).connect(this.master)
    const streamer = new AudioStreamer(this.ctx, input, gain)
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.className = 'bs-video'
    const url = URL.createObjectURL(file)
    video.src = url
    const et: EngineTrack = { track, file, input, streamer, gain, pan, video, url }
    this.tracks.set(track.id, et)
    this.applyVideoStyle(et)
    this.applyMix()
    await streamer.prepare().catch(() => false)
    // Show the frame at timeline 0.
    video.addEventListener('loadedmetadata', () => void seekVideo(video, fileTimeAt(track, 0) + track.videoDelayMs / 1000), { once: true })
    this.emit('tracks', this.trackIds())
  }

  updateTrack(track: Track): void {
    const et = this.tracks.get(track.id)
    if (!et) return
    et.track = track
    this.applyVideoStyle(et)
    this.applyMix()
  }

  removeTrack(id: string): void {
    const et = this.tracks.get(id)
    if (!et) return
    et.streamer.stop()
    et.video.pause()
    et.video.removeAttribute('src')
    et.video.load()
    URL.revokeObjectURL(et.url)
    et.input.dispose()
    et.gain.disconnect()
    et.pan.disconnect()
    this.tracks.delete(id)
    this.emit('tracks', this.trackIds())
  }

  private applyVideoStyle(et: EngineTrack): void {
    et.video.style.transform = et.track.mirror ? 'scaleX(-1)' : ''
  }

  private applyMix(): void {
    const all = [...this.tracks.values()]
    const audible = new Set(audibleTracks(all.map((e) => e.track)).map((t) => t.id))
    const now = this.ctx.currentTime
    for (const et of all) {
      const g = audible.has(et.track.id) ? et.track.volume : 0
      et.gain.gain.setTargetAtTime(g, now, 0.015)
      et.pan.pan.setTargetAtTime(et.track.pan, now, 0.015)
    }
  }

  /**
   * A track's decoded audio on the timeline (mono), exactly as playback/export position it.
   * Used by automated tests and remote troubleshooting to verify alignment between tracks.
   */
  async timelineAudio(trackId: string, from: number, seconds: number): Promise<{ samples: Float32Array; sampleRate: number } | null> {
    const et = this.tracks.get(trackId)
    if (!et) return null
    const f0 = fileTimeAt(et.track, from)
    const seg = await decodeAudioSegment(et.input, Math.max(0, f0 - 0.2), f0 + seconds + 0.2)
    if (!seg) return null
    const start = Math.round((f0 - seg.startTime) * seg.sampleRate)
    return { samples: seg.samples.slice(start, start + Math.round(seconds * seg.sampleRate)), sampleRate: seg.sampleRate }
  }

  get duration(): number {
    return songDuration([...this.tracks.values()].map((e) => e.track))
  }

  /** Timeline position currently being heard. */
  position(): number {
    if (this._state === 'idle' || this._state === 'processing') return this.idlePos
    return audibleContextTime(this.ctx) - this.t0
  }

  private idlePos = 0

  // ---------------------------------------------------------------- transport

  private activeTracks(): EngineTrack[] {
    return [...this.tracks.values()].filter((e) => !this.excluded.has(e.track.id))
  }

  private async startSources(from: number, leadSec: number): Promise<void> {
    const all = this.activeTracks()
    await Promise.all(all.map((e) => e.streamer.prepare()))
    await Promise.all(all.map((e) => seekVideo(e.video, fileTimeAt(e.track, Math.max(0, from)) + e.track.videoDelayMs / 1000)))
    const sr = this.ctx.sampleRate
    this.t0 = Math.round((this.ctx.currentTime + leadSec - from) * sr) / sr
    for (const e of all) e.streamer.start(this.t0 + from, fileTimeAt(e.track, from))
    this.startFollowLoop()
  }

  private stopSources(): void {
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.metronome.stop()
    for (const e of this.tracks.values()) {
      e.streamer.stop()
      e.video.pause()
      e.video.playbackRate = 1
    }
  }

  private startFollowLoop(): void {
    cancelAnimationFrame(this.raf)
    const loop = () => {
      if (this.disposed) return
      const pos = this.position()
      this.followVideos(pos)
      if (this._state === 'countin' && pos >= 0) this.setState('recording')
      if (this._state === 'playing' && pos > this.duration + 0.25) {
        void this.stop().then(() => this.emit('ended', undefined))
        return
      }
      if (this._state === 'recording' && pos >= MAX_SONG_SECONDS) {
        void this.stop()
        return
      }
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  private followVideos(pos: number): void {
    for (const e of this.activeTracks()) {
      const v = e.video
      if (v.readyState < 2) continue
      const target = fileTimeAt(e.track, pos) + e.track.videoDelayMs / 1000
      const start = fileTimeAt(e.track, 0) + e.track.videoDelayMs / 1000
      if (pos < 0 || target < 0) {
        if (!v.paused) v.pause()
        if (Math.abs(v.currentTime - Math.max(0, start)) > 0.06 && !v.seeking) v.currentTime = Math.max(0, start)
        continue
      }
      if (target >= (v.duration || Infinity) - 0.05) {
        if (!v.paused) v.pause()
        continue
      }
      if (v.paused) void v.play().catch(() => undefined)
      const diff = v.currentTime - target
      if (Math.abs(diff) > 0.3) {
        if (!v.seeking) v.currentTime = target + 0.04
        v.playbackRate = 1
      } else if (Math.abs(diff) > 0.025) {
        v.playbackRate = Math.min(1.15, Math.max(0.85, 1 - diff * 1.5))
      } else if (v.playbackRate !== 1) {
        v.playbackRate = 1
      }
    }
  }

  async play(from = 0): Promise<void> {
    if (this._state !== 'idle') await this.stop()
    if (this.ctx.state !== 'running') await this.ctx.resume()
    this.excluded.clear()
    if (this.tracks.size === 0) return
    const start = Math.max(0, Math.min(from, Math.max(0, this.duration - 0.1)))
    this.setState('playing')
    await this.startSources(start, 0.2)
  }

  seekIdle(pos: number): void {
    if (this._state !== 'idle') return
    this.idlePos = Math.max(0, pos)
    for (const e of this.tracks.values()) {
      const t = fileTimeAt(e.track, this.idlePos) + e.track.videoDelayMs / 1000
      if (e.video.readyState >= 1) e.video.currentTime = Math.max(0, t)
    }
  }

  async record(o: RecordOptions): Promise<void> {
    if (!this.stream) throw new Error('Abra a câmera e o microfone antes de gravar.')
    if (this._state !== 'idle') await this.stop()
    if (this.ctx.state !== 'running') await this.ctx.resume()
    const takeId = uid()
    this.excluded = new Set(o.exclude ?? [])
    for (const id of this.excluded) this.tracks.get(id)?.video.pause()
    const recorder = await TakeRecorder.create(this.stream, paths.take(takeId), this.quality)
    await this.capture.start(120, 30, paths.takePcm(takeId))
    await recorder.start(this.ctx)
    const { rtl, calibrated } = effectiveRtlSec(this.ctx, this.micKey)
    const spb = 60 / o.bpm
    const countIn = o.countInBeats * spb
    this.setState('countin')
    await this.startSources(0, 0.35 + countIn)
    this.take = { takeId, slot: o.slot, recorder, rtl, calibrated, t0: this.t0, frontCamera: isFrontFacing(this.stream) }
    if (o.countInBeats > 0 || o.metronome) {
      this.metronome.start({
        t0: this.t0,
        bpm: o.bpm,
        beatsPerBar: o.beatsPerBar,
        fromBeat: -o.countInBeats,
        toBeat: o.metronome ? Number.POSITIVE_INFINITY : 0,
      })
    }
    if (countIn === 0) this.setState('recording')
  }

  /** Stops playback or recording. Resolves with the processed take when a recording was running. */
  async stop(): Promise<TakeResult | null> {
    const take = this.take
    const pos = this.position()
    this.stopSources()
    if (!take) {
      this.idlePos = 0
      this.setState('idle')
      return null
    }
    this.take = null
    this.setState('processing')
    try {
      const [cap] = await Promise.all([this.capture.stop(), take.recorder.stop()])
      const raw = await readFile(paths.take(take.takeId))
      const cleanup = async () => {
        await removeEntry(paths.take(take.takeId))
        await removeEntry(paths.takePcm(take.takeId))
      }
      if (pos < 0.5 || !raw || raw.size === 0) {
        await cleanup()
        return null
      }
      const sr = this.ctx.sampleRate
      const fallbackLag = take.recorder.startedAtCtx !== null ? Math.round(take.recorder.startedAtCtx * sr) - cap.startFrame : 0
      let file: File
      let info: MediaInfo
      let startOffset: number
      let al: AlignResult
      try {
        // Preferred: sample-exact sound from our capture + the recorder's picture placed on it.
        const built = await buildTrackFile(raw, cap, paths.track(take.takeId), fallbackLag)
        file = built.file
        info = built.info
        al = built.video
        startOffset = computeStartOffset(built.audioStartFrame, sr, take.t0, take.rtl)
      } catch (err) {
        console.warn('[engine] precise track build failed, using recorder audio', err)
        const fin = await finalizeRecording(raw, paths.track(take.takeId))
        file = fin.file
        info = fin.info
        const input = openInput(file)
        try {
          al = await alignFileToCapture(cap, (a, b) => decodeAudioSegment(input, a, b), fallbackLag)
        } finally {
          input.dispose()
        }
        startOffset = computeStartOffset(al.fileStartFrame, sr, take.t0, take.rtl)
      }
      await cleanup()
      const result: TakeResult = {
        takeId: take.takeId,
        slot: take.slot,
        file,
        info,
        startOffset,
        syncQuality: al.quality,
        syncScore: al.score,
        driftPpm: al.driftPpm,
        latencyMs: take.rtl * 1000,
        calibrated: take.calibrated,
        frontCamera: take.frontCamera,
      }
      this.emit('take', result)
      return result
    } catch (err) {
      this.emit('error', `Falha ao processar a gravação: ${err instanceof Error ? err.message : String(err)}`)
      await take.recorder.abort()
      return null
    } finally {
      this.excluded.clear()
      this.idlePos = 0
      this.setState('idle')
    }
  }

  dispose(): void {
    this.disposed = true
    this.stopSources()
    if (this.take) {
      void this.take.recorder.abort()
      void this.capture.stop()
      this.take = null
    }
    for (const id of [...this.tracks.keys()]) this.removeTrack(id)
    this.closeDevices()
    void keepScreenOn(false)
  }
}
