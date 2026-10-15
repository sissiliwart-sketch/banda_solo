export type Quality = '720p' | '1080p'

export interface DeviceSelection {
  cameraId: string | null
  micId: string | null
  quality: Quality
}

export interface DeviceInfo {
  id: string
  label: string
  kind: MediaDeviceKind
  external: boolean
}

const KEY = 'bs.devices.v1'

export function loadSelection(): DeviceSelection {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as Partial<DeviceSelection> | null
    return { cameraId: raw?.cameraId ?? null, micId: raw?.micId ?? null, quality: raw?.quality === '1080p' ? '1080p' : '720p' }
  } catch {
    return { cameraId: null, micId: null, quality: '720p' }
  }
}

export function saveSelection(s: DeviceSelection): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

function looksExternal(label: string): boolean {
  const l = label.toLowerCase()
  return /usb|external|externa|uvc|webcam|logi|c9[0-9]{2}|brio|elgato|razer|anker|obsbot|insta360/.test(l)
}

export async function listDevices(): Promise<{ cameras: DeviceInfo[]; mics: DeviceInfo[] }> {
  const all = await navigator.mediaDevices.enumerateDevices()
  const map = (d: MediaDeviceInfo, i: number): DeviceInfo => ({
    id: d.deviceId,
    kind: d.kind,
    label: d.label || (d.kind === 'videoinput' ? `Câmera ${i + 1}` : `Microfone ${i + 1}`),
    external: looksExternal(d.label),
  })
  const cameras = all.filter((d) => d.kind === 'videoinput').map(map)
  const mics = all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications').map(map)
  return { cameras, mics }
}

export function describeCameraLabel(label: string): string {
  const l = label.toLowerCase()
  if (l.includes('front') || l.includes('frontal')) return `${label} (frontal)`
  if (l.includes('back') || l.includes('traseira') || l.includes('rear')) return `${label} (traseira)`
  return label
}

/** Microphone constraints tuned for music: no echo cancellation / noise suppression / AGC. */
export function musicAudioConstraints(micId: string | null): MediaTrackConstraints {
  const c: MediaTrackConstraints & Record<string, unknown> = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 48000 },
  }
  if (micId) c.deviceId = { exact: micId }
  // Chrome-specific switches some Android builds still honour.
  c.googEchoCancellation = false
  c.googAutoGainControl = false
  c.googNoiseSuppression = false
  c.googHighpassFilter = false
  return c
}

export function videoConstraints(cameraId: string | null, quality: Quality): MediaTrackConstraints {
  const hd = quality === '1080p'
  const c: MediaTrackConstraints = {
    width: { ideal: hd ? 1920 : 1280 },
    height: { ideal: hd ? 1080 : 720 },
    frameRate: { ideal: 30, max: 30 },
  }
  if (cameraId) c.deviceId = { exact: cameraId }
  else c.facingMode = 'user'
  return c
}

export async function openStream(sel: DeviceSelection, withVideo = true): Promise<MediaStream> {
  if (localStorage.getItem('bs.test.loopback') === '1') {
    const { loopbackAudioTrack } = await import('../audio/context')
    const cam = withVideo ? await navigator.mediaDevices.getUserMedia({ video: videoConstraints(sel.cameraId, sel.quality) }) : new MediaStream()
    return new MediaStream([...cam.getVideoTracks(), loopbackAudioTrack()])
  }
  const audio = musicAudioConstraints(sel.micId)
  const video = withVideo ? videoConstraints(sel.cameraId, sel.quality) : false
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video })
  } catch (err) {
    // A device that was unplugged: fall back to defaults instead of failing.
    if (err instanceof DOMException && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      return navigator.mediaDevices.getUserMedia({
        audio: musicAudioConstraints(null),
        video: withVideo ? videoConstraints(null, sel.quality) : false,
      })
    }
    throw err
  }
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop())
}

export function isFrontFacing(stream: MediaStream | null): boolean {
  const t = stream?.getVideoTracks()[0]
  if (!t) return false
  const s = t.getSettings()
  if (s.facingMode) return s.facingMode === 'user'
  return /front|frontal|user/i.test(t.label)
}

export function streamSummary(stream: MediaStream | null): string {
  const v = stream?.getVideoTracks()[0]?.getSettings()
  const a = stream?.getAudioTracks()[0]?.getSettings()
  const parts: string[] = []
  if (v?.width && v?.height) parts.push(`${v.width}×${v.height}${v.frameRate ? ` @ ${Math.round(v.frameRate)}fps` : ''}`)
  if (a?.sampleRate) parts.push(`${a.sampleRate / 1000} kHz${a.channelCount ? ` · ${a.channelCount === 1 ? 'mono' : 'estéreo'}` : ''}`)
  return parts.join(' · ')
}

export function permissionErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'Permissão negada. Libere câmera e microfone nas configurações do navegador para este site.'
    if (err.name === 'NotFoundError') return 'Nenhuma câmera ou microfone encontrado.'
    if (err.name === 'NotReadableError') return 'A câmera ou o microfone está sendo usado por outro app. Feche-o e tente de novo.'
  }
  return err instanceof Error ? err.message : String(err)
}
