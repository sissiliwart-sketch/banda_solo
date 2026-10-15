import { canEncodeAudio, canEncodeVideo } from 'mediabunny'
import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { getAudioContext, reportedOutputLatency } from '../audio/context'
import { IconBack, IconCamera, IconCheck, IconCopy, IconMic, IconWarning } from '../components/icons'
import { Button, Card, IconButton, Segmented, toast } from '../components/ui'
import { describeCameraLabel, listDevices, permissionErrorMessage, streamSummary, type DeviceInfo, type DeviceSelection, type Quality } from '../media/devices'
import { opfsAvailable, storageEstimate } from '../media/opfs'
import { supportedRecorderTypes } from '../media/recorder'
import { CalibrationPanel } from '../studio/DevicesSheet'
import { StudioEngine } from '../studio/engine'
import { LevelMeter } from '../studio/LevelMeter'
import { MountedVideo } from '../studio/Stage'
import { formatBytes } from '../lib/util'

interface Support {
  label: string
  ok: boolean
  detail?: string
}

async function checkSupport(): Promise<Support[]> {
  const out: Support[] = []
  const rec = supportedRecorderTypes()
  out.push({ label: 'Gravação de vídeo (MediaRecorder)', ok: rec.length > 0, detail: rec[0] ?? 'não suportado' })
  out.push({ label: 'AudioWorklet (sincronia precisa)', ok: typeof AudioWorkletNode !== 'undefined' })
  out.push({ label: 'WebCodecs (gerar vídeo final)', ok: typeof VideoEncoder !== 'undefined' })
  const avc = await canEncodeVideo('avc', { width: 1080, height: 1920 }).catch(() => false)
  const aac = await canEncodeAudio('aac').catch(() => false)
  out.push({ label: 'Vídeo final em MP4 (H.264 + AAC)', ok: avc && aac, detail: avc ? (aac ? 'MP4' : 'MP4 com áudio Opus') : 'vai gerar WebM' })
  const opfs = await opfsAvailable()
  const est = await storageEstimate()
  out.push({ label: 'Armazenamento no aparelho', ok: opfs, detail: est ? `${formatBytes(est.usage)} usados de ${formatBytes(est.quota)}` : undefined })
  out.push({ label: 'Manter tela ligada', ok: 'wakeLock' in navigator })
  out.push({ label: 'Compartilhar arquivos', ok: typeof navigator.canShare === 'function' })
  const ctx = getAudioContext()
  out.push({
    label: 'Áudio',
    ok: true,
    detail: `${ctx.sampleRate} Hz · latência de saída informada ${(reportedOutputLatency(ctx) * 1000).toFixed(0)} ms`,
  })
  return out
}

function Section({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <h2 className="mb-3 flex items-center gap-2 font-bold">
        {icon}
        {title}
      </h2>
      {children}
    </Card>
  )
}

export default function DiagnosticsPage() {
  const nav = useNavigate()
  const [engine, setEngine] = useState<StudioEngine | null>(null)
  const [devices, setDevices] = useState<{ cameras: DeviceInfo[]; mics: DeviceInfo[] }>({ cameras: [], mics: [] })
  const [sel, setSel] = useState<DeviceSelection>({ cameraId: null, micId: null, quality: '720p' })
  const [error, setError] = useState<string | null>(null)
  const [support, setSupport] = useState<Support[]>([])
  const [summary, setSummary] = useState('')
  const [caps, setCaps] = useState('')

  useEffect(() => {
    let alive = true
    let eng: StudioEngine | null = null
    StudioEngine.create().then((e) => {
      if (!alive) return e.dispose()
      eng = e
      setEngine(e)
    })
    void checkSupport().then((s) => alive && setSupport(s))
    return () => {
      alive = false
      eng?.dispose()
    }
  }, [])

  useEffect(() => {
    if (!engine) return
    let cancelled = false
    engine
      .openDevices(sel)
      .then(async (stream) => {
        if (cancelled) return
        setError(null)
        setSummary(streamSummary(stream))
        const v = stream.getVideoTracks()[0]
        const c = v?.getCapabilities?.()
        setCaps(c?.width && c?.height ? `até ${c.width.max}×${c.height.max}${c.frameRate?.max ? ` @ ${Math.round(c.frameRate.max)}fps` : ''}` : '')
        setDevices(await listDevices())
      })
      .catch((err) => !cancelled && setError(permissionErrorMessage(err)))
    return () => {
      cancelled = true
    }
  }, [engine, sel])

  useEffect(() => {
    const md = navigator.mediaDevices
    if (!md) return
    const reload = () => void listDevices().then(setDevices)
    md.addEventListener('devicechange', reload)
    return () => md.removeEventListener('devicechange', reload)
  }, [])

  const stream = engine?.mediaStream
  const activeCam = stream?.getVideoTracks()[0]?.getSettings().deviceId
  const activeMic = stream?.getAudioTracks()[0]?.getSettings().deviceId

  function report(): string {
    const lines = [
      `Banda Solo — diagnóstico (${new Date().toLocaleString('pt-BR')})`,
      `Navegador: ${navigator.userAgent}`,
      `Câmeras: ${devices.cameras.map((c) => `${c.label}${c.external ? ' [externa]' : ''}`).join(' | ') || 'nenhuma'}`,
      `Microfones: ${devices.mics.map((m) => m.label).join(' | ') || 'nenhum'}`,
      `Em uso: ${summary}${caps ? ` (${caps})` : ''}`,
      ...support.map((s) => `${s.ok ? 'OK ' : 'NÃO'} ${s.label}${s.detail ? ` — ${s.detail}` : ''}`),
      `Latência: ${engine ? JSON.stringify(engine.latencyInfo()) : '-'}`,
    ]
    return lines.join('\n')
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 pb-16 pt-3">
      <header className="safe-top flex items-center gap-2">
        <IconButton label="Voltar" onClick={() => (history.length > 1 ? nav(-1) : nav('/'))}>
          <IconBack />
        </IconButton>
        <h1 className="flex-1 text-xl font-extrabold">Teste de câmera e microfone</h1>
        <Button
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(report())
              toast.ok('Relatório copiado')
            } catch {
              toast.error('Não consegui copiar')
            }
          }}
        >
          <IconCopy size={16} /> Copiar relatório
        </Button>
      </header>

      {error ? (
        <p className="flex items-start gap-2 rounded-2xl border border-rec/40 bg-rec/10 p-4 text-sm text-[#ffd2cd]">
          <IconWarning className="shrink-0" /> {error}
        </p>
      ) : null}

      <Section title="Câmeras encontradas" icon={<IconCamera />}>
        <p className="mb-3 text-sm text-muted">
          Conecte a webcam USB agora (com hub USB-C se precisar) — a lista atualiza sozinha. Toque numa câmera para testar.
        </p>
        <ul className="mb-3 space-y-1.5">
          {devices.cameras.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => setSel({ ...sel, cameraId: c.id })}
                className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition ${c.id === activeCam ? 'bg-accent/15 text-accent' : 'bg-panel-2 hover:bg-panel-3'}`}
              >
                <span>{describeCameraLabel(c.label)}</span>
                <span className="flex items-center gap-2">
                  {c.external ? <span className="rounded-md bg-info/20 px-1.5 py-0.5 text-xs font-bold text-info">externa</span> : null}
                  {c.id === activeCam ? <IconCheck size={18} /> : null}
                </span>
              </button>
            </li>
          ))}
          {devices.cameras.length === 0 ? <li className="text-sm text-faint">Nenhuma câmera ainda (permita o acesso).</li> : null}
        </ul>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="aspect-video overflow-hidden rounded-xl bg-black">{engine ? <MountedVideo el={engine.preview} /> : null}</div>
          <div className="space-y-2 text-sm">
            <Segmented<Quality>
              value={sel.quality}
              onChange={(q) => setSel({ ...sel, quality: q })}
              options={[
                { value: '720p', label: '720p' },
                { value: '1080p', label: '1080p' },
              ]}
            />
            <p className="text-muted">{summary || '—'}</p>
            {caps ? <p className="text-faint">Câmera suporta {caps}</p> : null}
          </div>
        </div>
      </Section>

      <Section title="Microfones" icon={<IconMic />}>
        <ul className="mb-3 space-y-1.5">
          {devices.mics.map((m) => (
            <li key={m.id}>
              <button
                onClick={() => setSel({ ...sel, micId: m.id })}
                className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition ${m.id === activeMic ? 'bg-accent/15 text-accent' : 'bg-panel-2 hover:bg-panel-3'}`}
              >
                <span>{m.label}</span>
                {m.id === activeMic ? <IconCheck size={18} /> : null}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-3 text-sm text-muted">
          Fale ou toque algo: <LevelMeter engine={engine} className="w-48" />
        </div>
        <p className="mt-2 text-xs text-faint">Toque na tela uma vez para ativar o áudio, se o medidor não se mexer.</p>
      </Section>

      <CalibrationPanel engine={engine} />

      <Section title="Recursos do navegador">
        <ul className="space-y-1.5 text-sm">
          {support.map((s) => (
            <li key={s.label} className="flex items-start gap-2">
              {s.ok ? <IconCheck size={18} className="shrink-0 text-ok" /> : <IconWarning size={18} className="shrink-0 text-accent" />}
              <span>
                {s.label}
                {s.detail ? <span className="text-faint"> — {s.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  )
}
