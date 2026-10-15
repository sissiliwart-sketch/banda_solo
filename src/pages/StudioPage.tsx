import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router'
import { resumeAudio } from '../audio/context'
import {
  IconBack,
  IconCamera,
  IconExport,
  IconHeadphones,
  IconMetronome,
  IconPlay,
  IconRecord,
  IconSettings,
  IconSliders,
  IconStop,
  IconTrash,
  IconUsers,
  IconWarning,
  IconRefresh,
  IconCloud,
} from '../components/icons'
import { ProjectSettingsForm } from '../components/ProjectSettingsForm'
import { Button, IconButton, Modal, ProgressBar, Spinner, toast } from '../components/ui'
import { MAX_SONG_SECONDS } from '../config'
import { dropTrackFile, ensureTrackFile } from '../data/mediaCache'
import { useApp } from '../data/store'
import { DEFAULT_MIX, songDuration, type NewTrack, type Project, type ProjectSettings, type Track, type UserInfo } from '../data/types'
import { loadSelection, permissionErrorMessage, saveSelection, type DeviceSelection } from '../media/devices'
import { paths, removeEntry, requestPersistence } from '../media/opfs'
import { CalibrationPanel, DevicesSheet } from '../studio/DevicesSheet'
import { StudioEngine, type TakeResult, type TransportState } from '../studio/engine'
import { ExportSheet } from '../studio/ExportSheet'
import { getLayout } from '../studio/layouts'
import { LevelMeter } from '../studio/LevelMeter'
import { InstrumentChips, MixerSheet, TrackControls } from '../studio/MixerSheet'
import { ShareSheet } from '../studio/ShareSheet'
import { MountedVideo, Stage } from '../studio/Stage'
import { errorMessage, formatTime } from '../lib/util'

type Sheet = null | 'mixer' | 'devices' | 'share' | 'export' | 'settings'

/** One visible track per slot: the most recently updated wins (a re-recording replaces the old one). */
function resolveSlots(tracks: Track[]): Map<number, Track> {
  const m = new Map<number, Track>()
  for (const t of tracks) {
    const cur = m.get(t.slot)
    if (!cur || t.updatedAt > cur.updatedAt) m.set(t.slot, t)
  }
  return m
}

function buildTakeTrack(r: TakeResult, project: Project, user: UserInfo, prev?: Track): Track {
  return {
    ...DEFAULT_MIX,
    id: r.takeId,
    projectId: project.id,
    slot: r.slot,
    userId: user.id,
    musicianName: prev?.musicianName || user.name,
    instrument: prev?.instrument || '',
    fileIds: [],
    mimeType: r.info.mimeType || 'video/webm',
    sizeBytes: r.file.size,
    duration: r.info.duration,
    startOffset: r.startOffset,
    status: 'uploading',
    syncQuality: r.syncQuality,
    latencyMs: r.latencyMs,
    driftPpm: r.driftPpm,
    width: r.info.width,
    height: r.info.height,
    updatedAt: new Date().toISOString(),
    mirror: r.frontCamera,
    volume: prev?.volume ?? 1,
    pan: prev?.pan ?? 0,
  }
}

function toNewTrack(t: Track): NewTrack {
  const copy: Partial<Track> = { ...t }
  delete copy.id
  delete copy.updatedAt
  delete copy.status
  delete copy.fileIds
  return copy as NewTrack
}

function omit<T extends Record<string, unknown>>(o: T, key: string): T {
  const copy = { ...o }
  delete copy[key]
  return copy
}

const TIP_KEY = 'bs.tip.headphones'

export default function StudioPage() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const { backend, user } = useApp()
  const [project, setProject] = useState<Project | null>(null)
  const [tracks, setTracks] = useState<Track[]>([])
  const [files, setFiles] = useState<Record<string, File>>({})
  const [downloads, setDownloads] = useState<Record<string, number>>({})
  const [uploads, setUploads] = useState<Record<string, number | 'error'>>({})
  const [engine, setEngine] = useState<StudioEngine | null>(null)
  const [transport, setTransport] = useState<TransportState>('idle')
  const [armed, setArmed] = useState(0)
  const [take, setTake] = useState<{ result: TakeResult; track: Track } | null>(null)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [selection, setSelection] = useState<DeviceSelection>(loadSelection)
  const [deviceState, setDeviceState] = useState<'off' | 'opening' | 'on' | 'error'>('off')
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const [monitor, setMonitor] = useState(false)
  const [pos, setPos] = useState(0)
  const [seekPos, setSeekPos] = useState(0)
  const [menuSlot, setMenuSlot] = useState<number | null>(null)
  const [askCalibrate, setAskCalibrate] = useState(false)
  const [showTip, setShowTip] = useState(() => localStorage.getItem(TIP_KEY) !== '1')
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const filesRef = useRef(files)
  const tracksRef = useRef(tracks)
  const downloading = useRef(new Set<string>())
  const pendingMix = useRef(new Map<string, { patch: Partial<Track>; timer: number }>())
  const projectRef = useRef(project)
  const calibAsked = useRef(false)
  useLayoutEffect(() => {
    filesRef.current = files
    tracksRef.current = tracks
    projectRef.current = project
  })

  // ------------------------------------------------------------- loading

  const reloadTracks = useCallback(async () => {
    if (!id) return
    try {
      const list = await backend.listTracks(id)
      setTracks((prev) =>
        list.map((t) => {
          const pending = pendingMix.current.get(t.id)
          const local = prev.find((p) => p.id === t.id)
          return pending && local ? local : t
        }),
      )
    } catch (err) {
      console.warn(err)
    }
  }, [backend, id])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const p = await backend.getProject(id)
        const list = await backend.listTracks(id)
        if (!alive) return
        setProject(p)
        setTracks(list)
        const used = new Set(list.map((t) => t.slot))
        setArmed([...Array(p.slots).keys()].find((i) => !used.has(i)) ?? 0)
      } catch (err) {
        toast.error(errorMessage(err))
        nav('/', { replace: true })
      }
    })()
    void requestPersistence()
    return () => {
      alive = false
    }
  }, [backend, id, nav])

  useEffect(() => {
    if (!id) return
    let timer = 0
    const off = backend.watchTracks(id, () => {
      clearTimeout(timer)
      timer = window.setTimeout(() => void reloadTracks(), 700)
    })
    const onFocus = () => void reloadTracks()
    window.addEventListener('focus', onFocus)
    return () => {
      off()
      clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [backend, id, reloadTracks])

  // -------------------------------------------------------------- engine

  useEffect(() => {
    let alive = true
    let eng: StudioEngine | null = null
    StudioEngine.create()
      .then((e) => {
        if (!alive) return e.dispose()
        eng = e
        setEngine(e)
        ;(window as unknown as { __bandaSoloEngine?: StudioEngine }).__bandaSoloEngine = e
      })
      .catch((err) => toast.error(`Áudio indisponível neste navegador: ${errorMessage(err)}`))
    return () => {
      alive = false
      eng?.dispose()
    }
  }, [])

  useEffect(() => {
    if (!engine) return
    const offs = [
      engine.on('state', setTransport),
      engine.on('error', (m) => toast.error(m)),
      engine.on('tracks', () => bump()),
      engine.on('take', (r) => {
        const p = projectRef.current
        const u = useApp.getState().user
        if (!p || !u) return
        setTake({ result: r, track: buildTakeTrack(r, p, u, resolveSlots(tracksRef.current).get(r.slot)) })
        // Exposed for automated tests and remote troubleshooting.
        ;(window as unknown as { __bandaSolo?: unknown }).__bandaSolo = {
          lastTake: { slot: r.slot, syncQuality: r.syncQuality, syncScore: r.syncScore, startOffset: r.startOffset, latencyMs: r.latencyMs, driftPpm: r.driftPpm, duration: r.info.duration, mimeType: r.info.mimeType },
        }
        if (r.syncQuality === 'estimated') toast.info('Não consegui medir a sincronia desta gravação com precisão — confira no mixer.')
      }),
    ]
    return () => offs.forEach((f) => f())
  }, [engine])

  useEffect(() => {
    if (!engine) return
    let cancelled = false
    setDeviceState('opening')
    engine
      .openDevices(selection)
      .then(() => {
        if (cancelled) return
        setDeviceState('on')
        setDeviceError(null)
        bump()
      })
      .catch((err) => {
        if (cancelled) return
        setDeviceState('error')
        setDeviceError(permissionErrorMessage(err))
      })
    saveSelection(selection)
    return () => {
      cancelled = true
    }
  }, [engine, selection])

  useEffect(() => {
    engine?.setMonitor(monitor)
  }, [engine, monitor])

  useEffect(() => {
    const md = navigator.mediaDevices
    if (!md) return
    let known = -1
    const onChange = async () => {
      const n = (await md.enumerateDevices()).filter((d) => d.kind === 'videoinput').length
      if (known >= 0 && n > known) toast.info('Nova câmera conectada — escolha em “Câmera e microfone”.')
      known = n
    }
    void onChange()
    md.addEventListener('devicechange', onChange)
    return () => md.removeEventListener('devicechange', onChange)
  }, [])

  // ------------------------------------------------------- media files

  useEffect(() => {
    let alive = true
    void (async () => {
      for (const t of tracks) {
        if (!alive) return
        if (t.status !== 'ready' || filesRef.current[t.id] || downloading.current.has(t.id)) continue
        downloading.current.add(t.id)
        setDownloads((d) => ({ ...d, [t.id]: 0 }))
        try {
          const f = await ensureTrackFile(backend, t, (p) => setDownloads((d) => ({ ...d, [t.id]: p })))
          setFiles((fs) => ({ ...fs, [t.id]: f }))
        } catch (err) {
          toast.error(`Não consegui baixar a tela ${t.slot + 1}: ${errorMessage(err)}`)
        } finally {
          downloading.current.delete(t.id)
          setDownloads((d) => omit(d, t.id))
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [tracks, backend])

  const bySlot = useMemo(() => resolveSlots(tracks), [tracks])

  const engineTracks = useMemo(() => {
    const list: { track: Track; file: File }[] = []
    for (const [slot, t] of bySlot) {
      if (take && take.track.slot === slot) continue
      const f = files[t.id]
      if (f) list.push({ track: t, file: f })
    }
    if (take) list.push({ track: take.track, file: take.result.file })
    return list
  }, [bySlot, files, take])

  useEffect(() => {
    if (!engine) return
    const wanted = new Set(engineTracks.map((x) => x.track.id))
    for (const tid of engine.trackIds()) if (!wanted.has(tid)) engine.removeTrack(tid)
    for (const { track, file } of engineTracks) void engine.setTrack(track, file)
  }, [engine, engineTracks])

  // ------------------------------------------------------------ position

  useEffect(() => {
    if (!engine || transport === 'idle' || transport === 'processing') return
    let raf = 0
    let last = 0
    const tick = (ts: number) => {
      if (ts - last > 50) {
        setPos(engine.position())
        last = ts
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [engine, transport])

  const duration = songDuration(engineTracks.map((x) => x.track))
  const shownPos = transport === 'idle' || transport === 'processing' ? seekPos : pos

  // -------------------------------------------------------------- actions

  const busy = transport !== 'idle'

  async function onPlay() {
    if (!engine) return
    await resumeAudio()
    if (busy) {
      await engine.stop()
      return
    }
    await engine.play(seekPos >= duration - 0.25 ? 0 : seekPos)
  }

  async function onRecord(skipCalibration = false) {
    if (!engine || !project) return
    await resumeAudio()
    if (busy) return
    if (take) {
      toast.info('Salve ou descarte a gravação anterior primeiro.')
      return
    }
    if (deviceState !== 'on') {
      setSheet('devices')
      return
    }
    const occupant = bySlot.get(armed)
    if (occupant && occupant.status === 'uploading' && !files[occupant.id]) {
      toast.error('Outra pessoa está gravando nesta tela agora.')
      return
    }
    if (!skipCalibration && !calibAsked.current && !engine.latencyInfo().calibrated && engineTracks.length > 0) {
      calibAsked.current = true
      setAskCalibrate(true)
      return
    }
    try {
      await engine.record({
        slot: armed,
        bpm: project.bpm,
        beatsPerBar: project.beatsPerBar,
        countInBeats: project.countInBars * project.beatsPerBar,
        metronome: project.metronome,
        exclude: occupant ? [occupant.id] : [],
      })
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  async function onStop() {
    if (!engine) return
    const wasRecording = transport === 'recording' || transport === 'countin'
    const r = await engine.stop()
    setSeekPos(0)
    if (!r && wasRecording) toast.info('Gravação muito curta — descartada.')
  }

  async function uploadTrack(t: Track, file: File, replaced: Track[]) {
    const p = projectRef.current
    if (!p) return
    setUploads((u) => ({ ...u, [t.id]: 0 }))
    try {
      const fileIds = await backend.uploadTrackMedia(p, t, file, (f) => setUploads((u) => ({ ...u, [t.id]: f })))
      const ready = await backend.updateTrack(t.id, { fileIds, status: 'ready', ...(pendingMix.current.get(t.id)?.patch ?? {}) })
      setTracks((prev) => prev.map((x) => (x.id === t.id ? { ...ready, ...(pendingMix.current.get(t.id)?.patch ?? {}) } : x)))
      for (const r of replaced) {
        await backend.deleteTrack(p, r).catch(() => undefined)
        await dropTrackFile(r.id)
      }
      setUploads((u) => omit(u, t.id))
      if (backend.kind === 'cloud') toast.ok(`Tela ${t.slot + 1} salva na nuvem`)
    } catch (err) {
      setUploads((u) => ({ ...u, [t.id]: 'error' }))
      toast.error(`Falha ao enviar a tela ${t.slot + 1}: ${errorMessage(err)} Toque na tela para tentar de novo.`)
    }
  }

  async function saveTake() {
    if (!take || !project) return
    const { result, track } = take
    const replaced = tracks.filter((t) => t.slot === track.slot)
    try {
      const created = await backend.createTrack(project, track.id, toNewTrack(track))
      setFiles((f) => ({ ...f, [track.id]: result.file }))
      setTracks((prev) => [...prev.filter((x) => x.slot !== track.slot), { ...track, ...created, status: 'uploading' }])
      setTake(null)
      const used = new Set([...tracks.filter((t) => t.slot !== track.slot).map((t) => t.slot), track.slot])
      const next = [...Array(project.slots).keys()].map((i) => (track.slot + 1 + i) % project.slots).find((i) => !used.has(i))
      if (next !== undefined) setArmed(next)
      void uploadTrack(created, result.file, replaced)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  async function discardTake() {
    if (!take) return
    engine?.removeTrack(take.track.id)
    await removeEntry(paths.track(take.track.id))
    setTake(null)
  }

  async function retake() {
    const slot = take?.track.slot
    await discardTake()
    if (slot !== undefined) setArmed(slot)
    setTimeout(() => void onRecord(true), 50)
  }

  function changeTrack(trackId: string, patch: Partial<Track>) {
    if (take && take.track.id === trackId) {
      setTake({ ...take, track: { ...take.track, ...patch } })
      return
    }
    setTracks((prev) => prev.map((t) => (t.id === trackId ? { ...t, ...patch } : t)))
    const cur = pendingMix.current.get(trackId)
    if (cur) clearTimeout(cur.timer)
    const merged = { ...(cur?.patch ?? {}), ...patch }
    const timer = window.setTimeout(() => {
      pendingMix.current.delete(trackId)
      if (uploads[trackId] !== undefined) {
        // Still uploading: the final update after upload carries the patch.
        pendingMix.current.set(trackId, { patch: merged, timer: 0 })
        return
      }
      backend.updateTrack(trackId, merged).catch((err) => toast.error(`Não salvei o ajuste: ${errorMessage(err)}`))
    }, 700)
    pendingMix.current.set(trackId, { patch: merged, timer })
  }

  async function deleteTrack(t: Track) {
    if (!project) return
    if (!confirm(`Apagar a gravação da tela ${t.slot + 1}${t.musicianName ? ` (${t.musicianName})` : ''}?`)) return
    try {
      await backend.deleteTrack(project, t)
      await dropTrackFile(t.id)
      setTracks((prev) => prev.filter((x) => x.id !== t.id))
      setFiles((f) => omit(f, t.id))
      setArmed(t.slot)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  async function saveSettings(s: ProjectSettings) {
    if (!project) return
    try {
      const p = await backend.updateProject(project.id, { ...s, title: s.title.trim() || project.title })
      setProject(p)
      setSheet(null)
      if (armed >= p.slots) setArmed(0)
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  function onTileTap(slot: number) {
    if (busy || take) return
    const t = bySlot.get(slot)
    if (t && uploads[t.id] === 'error' && files[t.id]) {
      void uploadTrack(t, files[t.id], [])
      return
    }
    setArmed(slot)
  }

  async function goBack() {
    if (busy) {
      if (!confirm('Parar e sair do estúdio?')) return
      await engine?.stop()
    }
    if (take && !confirm('A última gravação ainda não foi salva. Sair mesmo assim?')) return
    nav('/')
  }

  // --------------------------------------------------------------- render

  if (!project || !user) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Spinner size={32} />
      </div>
    )
  }

  const layout = getLayout(project.layoutId, project.slots, project.aspect)
  const spb = 60 / project.bpm
  const latency = engine?.latencyInfo()
  const recording = transport === 'recording' || transport === 'countin'
  const usedSlots = [...bySlot.keys()]
  const exportBlocked = take
    ? 'Salve ou descarte a última gravação antes de gerar o vídeo.'
    : Object.keys(uploads).length || Object.keys(downloads).length
      ? 'Aguarde terminar de enviar/baixar as gravações.'
      : null

  const renderTile = (slot: number): ReactNode => {
    const t = take && take.track.slot === slot ? take.track : bySlot.get(slot)
    const isArmed = slot === armed && !take
    const live = isArmed && deviceState === 'on' && (recording || !t)
    const videoEl = live ? (engine?.preview ?? null) : t ? (engine?.videoFor(t.id) ?? null) : null
    const up = t ? uploads[t.id] : undefined
    const down = t ? downloads[t.id] : undefined
    const othersUploading = t && t.status === 'uploading' && !files[t.id] && !(take && take.track.id === t.id)
    const beatsLeft = transport === 'countin' ? Math.max(1, Math.ceil(-pos / spb)) : 0
    return (
      <div
        className={`relative h-full w-full overflow-hidden rounded-xl bg-panel transition ${
          isArmed ? (recording ? 'ring-4 ring-rec' : 'ring-2 ring-rec/80') : take && take.track.slot === slot ? 'ring-2 ring-accent' : ''
        }`}
        onClick={() => onTileTap(slot)}
        data-slot={slot}
      >
        {videoEl ? <MountedVideo el={videoEl} /> : null}
        {!videoEl ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 text-center">
            {othersUploading ? (
              <>
                <IconCloud className="text-muted" />
                <span className="text-xs text-muted">{t?.musicianName || 'Alguém'} está enviando…</span>
              </>
            ) : down !== undefined ? (
              <>
                <span className="text-xs text-muted">Baixando {Math.round(down * 100)}%</span>
                <ProgressBar value={down} className="max-w-[70%]" />
              </>
            ) : isArmed ? (
              <>
                <IconCamera className="text-rec" />
                <span className="text-xs font-semibold text-rec">{deviceState === 'opening' ? 'Abrindo câmera…' : 'Câmera desligada'}</span>
              </>
            ) : (
              <span className="text-2xl font-black text-line">{slot + 1}</span>
            )}
          </div>
        ) : null}

        <div className="pointer-events-none absolute left-1.5 top-1.5 flex items-center gap-1">
          <span className="rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-bold">{slot + 1}</span>
          {isArmed && !recording ? <span className="rounded-md bg-rec px-1.5 py-0.5 text-[11px] font-bold text-white">GRAVAR AQUI</span> : null}
          {isArmed && transport === 'recording' ? (
            <span className="bs-pulse flex items-center gap-1 rounded-md bg-rec px-1.5 py-0.5 text-[11px] font-bold text-white">● REC</span>
          ) : null}
          {t && t.syncQuality === 'estimated' && !live ? (
            <span className="rounded-md bg-accent/90 px-1.5 py-0.5 text-[11px] font-bold text-black" title="Sincronia estimada">
              ≈
            </span>
          ) : null}
        </div>

        {t && !live ? (
          <div className="pointer-events-none absolute bottom-1.5 left-1.5 right-1.5 flex items-end justify-between gap-1">
            <span className="truncate rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-semibold">
              {[t.musicianName, t.instrument].filter(Boolean).join(' · ')}
            </span>
            {up !== undefined ? (
              <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-bold ${up === 'error' ? 'bg-rec text-white' : 'bg-black/60 text-accent'}`}>
                {up === 'error' ? 'reenviar' : `↑ ${Math.round(up * 100)}%`}
              </span>
            ) : null}
          </div>
        ) : null}

        {t && !busy && !take && !live ? (
          <button
            className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-lg bg-black/55 text-lg font-bold"
            onClick={(e) => {
              e.stopPropagation()
              setMenuSlot(slot)
            }}
            aria-label={`Opções da tela ${slot + 1}`}
          >
            ⋯
          </button>
        ) : null}

        {isArmed && transport === 'countin' ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/35">
            <span className="text-7xl font-black text-white drop-shadow-lg">{beatsLeft}</span>
          </div>
        ) : null}
      </div>
    )
  }

  const menuTrack = menuSlot !== null ? bySlot.get(menuSlot) : undefined

  return (
    <div className="flex h-dvh flex-col" onPointerDown={() => void resumeAudio()}>
      {/* header */}
      <header className="safe-top flex items-center gap-1 border-b border-line px-2 pb-1.5">
        <IconButton label="Voltar" onClick={goBack}>
          <IconBack />
        </IconButton>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-extrabold leading-tight">{project.title}</h1>
          <p className="truncate text-xs text-muted">
            {project.bpm} BPM · {usedSlots.length}/{project.slots} telas{backend.kind === 'local' ? ' · modo local' : ''}
          </p>
        </div>
        <IconButton label="Gravar com outra pessoa" onClick={() => setSheet('share')} disabled={busy}>
          <IconUsers />
        </IconButton>
        <IconButton label="Configurações da música" onClick={() => setSheet('settings')} disabled={busy || !!take}>
          <IconSettings />
        </IconButton>
        <Button variant="primary" size="sm" onClick={() => setSheet('export')} disabled={busy || duration === 0}>
          <IconExport size={18} /> <span className="hidden sm:inline">Gerar vídeo</span>
        </Button>
      </header>

      {/* stage */}
      <main className="relative min-h-0 flex-1 p-2 sm:p-3">
        <Stage aspect={project.aspect} layout={layout} renderTile={renderTile} />
        {transport === 'processing' ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <div className="flex items-center gap-3 rounded-2xl bg-panel px-5 py-4 font-semibold">
              <Spinner /> Sincronizando a gravação…
            </div>
          </div>
        ) : null}
      </main>

      {showTip && engineTracks.length > 0 && !busy && !take ? (
        <div className="mx-2 mb-1 flex items-center gap-2 rounded-xl border border-line bg-panel-2 px-3 py-2 text-sm text-muted">
          <IconHeadphones size={18} className="shrink-0 text-accent" />
          <span className="flex-1">Grave sempre com fone com fio: sem fone, o microfone capta as outras faixas.</span>
          <button
            className="text-xs font-semibold text-text"
            onClick={() => {
              localStorage.setItem(TIP_KEY, '1')
              setShowTip(false)
            }}
          >
            Entendi
          </button>
        </div>
      ) : null}

      {/* take review or transport */}
      {take ? (
        <section className="safe-bottom border-t border-line bg-panel px-3 pt-3">
          <div className="mx-auto max-w-4xl space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-bold">Gravação da tela {take.track.slot + 1}</h2>
              <span className={`text-sm font-medium ${take.result.syncQuality === 'exact' ? 'text-ok' : 'text-accent'}`}>
                {take.result.syncQuality === 'exact' ? '✓ Sincronizada automaticamente' : '≈ Sincronia estimada — confira'}
                {` · latência ${take.result.latencyMs.toFixed(0)} ms${take.result.calibrated ? '' : ' (sem calibrar)'}`}
              </span>
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input
                    value={take.track.musicianName}
                    onChange={(e) => changeTrack(take.track.id, { musicianName: e.target.value })}
                    placeholder="Músico"
                    maxLength={60}
                    className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-panel-2 px-3 outline-none focus:border-accent"
                  />
                  <input
                    value={take.track.instrument}
                    onChange={(e) => changeTrack(take.track.id, { instrument: e.target.value })}
                    placeholder="Instrumento"
                    maxLength={40}
                    className="h-10 w-36 rounded-xl border border-line bg-panel-2 px-3 outline-none focus:border-accent"
                  />
                </div>
                <InstrumentChips value={take.track.instrument} onPick={(v) => changeTrack(take.track.id, { instrument: v })} />
                <details className="rounded-xl bg-panel-2 px-3 py-1">
                  <summary className="cursor-pointer py-1.5 text-sm font-medium text-muted">Ajustes desta faixa (volume, sincronia fina, espelhar)</summary>
                  <TrackControls track={take.track} onChange={(p) => changeTrack(take.track.id, p)} />
                </details>
              </div>
              <div className="flex flex-wrap items-start gap-2 md:flex-col md:items-stretch">
                <Button onClick={onPlay} className="flex-1">
                  {busy ? <IconStop size={18} /> : <IconPlay size={18} />} {busy ? 'Parar' : 'Ouvir com a banda'}
                </Button>
                <Button onClick={retake} disabled={busy} className="flex-1">
                  <IconRefresh size={18} /> Regravar
                </Button>
                <Button variant="danger" onClick={discardTake} disabled={busy} className="flex-1">
                  <IconTrash size={18} /> Descartar
                </Button>
                <Button variant="primary" onClick={saveTake} disabled={busy} className="flex-1">
                  Salvar tela {take.track.slot + 1}
                </Button>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="safe-bottom border-t border-line bg-panel px-3 pt-2">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex min-w-[10rem] flex-1 items-center gap-3">
              <span className="tabular w-[5.5rem] text-sm font-semibold">
                {formatTime(Math.max(0, shownPos))}
                <span className="text-faint"> / {formatTime(recording ? MAX_SONG_SECONDS : duration)}</span>
              </span>
              <input
                type="range"
                min={0}
                max={Math.max(0.1, duration)}
                step={0.05}
                value={Math.min(Math.max(0, shownPos), duration)}
                disabled={busy || duration === 0}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setSeekPos(v)
                  engine?.seekIdle(v)
                }}
                className="min-w-0 flex-1"
                aria-label="Posição"
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={onPlay}
                disabled={!engine || (!busy && engineTracks.length === 0) || transport === 'processing'}
                className="flex h-14 w-14 items-center justify-center rounded-full bg-panel-3 text-text transition hover:bg-line disabled:opacity-40"
                aria-label={busy ? 'Parar' : 'Tocar'}
              >
                {busy && !recording ? <IconStop size={26} /> : <IconPlay size={26} />}
              </button>
              <button
                onClick={() => (recording ? void onStop() : void onRecord())}
                disabled={!engine || transport === 'processing' || transport === 'playing'}
                className={`flex h-14 items-center gap-2 rounded-full px-5 font-bold text-white transition disabled:opacity-40 ${
                  recording ? 'bg-rec ring-4 ring-rec/30' : 'bg-rec hover:brightness-110'
                }`}
                aria-label={recording ? 'Parar gravação' : `Gravar tela ${armed + 1}`}
              >
                {recording ? <IconStop size={22} /> : <IconRecord size={22} />}
                <span>{recording ? 'Parar' : `Gravar tela ${armed + 1}`}</span>
              </button>
            </div>

            <div className="flex flex-1 items-center justify-end gap-1">
              <span className={`flex items-center gap-1 px-1 text-xs font-semibold ${project.metronome ? 'text-accent' : 'text-faint'}`} title="Metrônomo">
                <IconMetronome size={18} /> {project.bpm}
              </span>
              <LevelMeter engine={engine} className="hidden w-16 sm:block" />
              <IconButton label="Câmera, microfone e sincronia" onClick={() => setSheet('devices')} disabled={busy}>
                <IconCamera />
                {latency && !latency.calibrated ? <IconWarning size={16} className="text-accent" /> : null}
              </IconButton>
              <IconButton label="Mixer" onClick={() => setSheet('mixer')} disabled={recording}>
                <IconSliders />
              </IconButton>
            </div>
          </div>
        </section>
      )}

      {/* sheets */}
      <MixerSheet
        open={sheet === 'mixer'}
        onClose={() => setSheet(null)}
        tracks={engineTracks.map((x) => x.track)}
        onChange={changeTrack}
      />
      <DevicesSheet
        open={sheet === 'devices'}
        onClose={() => setSheet(null)}
        engine={engine}
        selection={selection}
        onSelection={setSelection}
        monitor={monitor}
        onMonitor={setMonitor}
        deviceError={deviceError}
      />
      <ShareSheet open={sheet === 'share'} onClose={() => setSheet(null)} project={project} cloud={backend.kind === 'cloud'} />
      <ExportSheet
        open={sheet === 'export'}
        onClose={() => setSheet(null)}
        project={project}
        tracks={engineTracks}
        blocked={exportBlocked}
      />
      <SettingsSheet key={sheet === 'settings' ? 'open' : 'closed'} open={sheet === 'settings'} onClose={() => setSheet(null)} project={project} minSlots={Math.max(2, ...usedSlots.map((s) => s + 1))} onSave={saveSettings} />

      <Modal open={menuSlot !== null} onClose={() => setMenuSlot(null)} title={`Tela ${(menuSlot ?? 0) + 1}`}>
        {menuTrack ? (
          <div className="space-y-2">
            <p className="text-sm text-muted">
              {[menuTrack.musicianName, menuTrack.instrument].filter(Boolean).join(' · ') || 'Gravação'} · {formatTime(menuTrack.duration)}
            </p>
            <Button
              className="w-full"
              onClick={() => {
                setArmed(menuTrack.slot)
                setMenuSlot(null)
              }}
            >
              <IconRecord size={18} className="text-rec" /> Gravar de novo nesta tela
            </Button>
            <Button
              className="w-full"
              onClick={() => {
                setMenuSlot(null)
                setSheet('mixer')
              }}
            >
              <IconSliders size={18} /> Ajustar no mixer
            </Button>
            <Button
              variant="danger"
              className="w-full"
              onClick={() => {
                setMenuSlot(null)
                void deleteTrack(menuTrack)
              }}
            >
              <IconTrash size={18} /> Apagar gravação
            </Button>
          </div>
        ) : null}
      </Modal>

      <Modal open={askCalibrate} onClose={() => setAskCalibrate(false)} title="Calibrar antes de gravar?">
        <p className="mb-3 text-sm text-muted">
          A calibração mede o atraso do seu tablet + fone e garante que esta faixa encaixe exatamente nas outras. Leva uns 7 segundos e só precisa ser feita uma
          vez por fone/microfone.
        </p>
        <CalibrationPanel engine={engine} onDone={() => setTimeout(() => setAskCalibrate(false), 900)} />
        <div className="mt-3 flex justify-end">
          <Button
            variant="ghost"
            onClick={() => {
              setAskCalibrate(false)
              void onRecord(true)
            }}
          >
            Gravar sem calibrar
          </Button>
        </div>
      </Modal>
    </div>
  )
}

function SettingsSheet({
  open,
  onClose,
  project,
  minSlots,
  onSave,
}: {
  open: boolean
  onClose: () => void
  project: Project
  minSlots: number
  onSave: (s: ProjectSettings) => Promise<void>
}) {
  const [value, setValue] = useState<ProjectSettings>(project)
  const [saving, setSaving] = useState(false)
  return (
    <Modal open={open} onClose={onClose} title="Configurações da música" wide>
      <ProjectSettingsForm value={value} onChange={setValue} minSlots={minSlots} />
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button
          variant="primary"
          loading={saving}
          onClick={async () => {
            setSaving(true)
            await onSave(value)
            setSaving(false)
          }}
        >
          Salvar
        </Button>
      </div>
    </Modal>
  )
}
