import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { IconCamera, IconCheck, IconHeadphones, IconMic, IconWarning } from '../components/icons'
import { Button, Modal, Segmented, Toggle } from '../components/ui'
import { resumeAudio } from '../audio/context'
import { describeCameraLabel, listDevices, streamSummary, type DeviceInfo, type DeviceSelection } from '../media/devices'
import type { StudioEngine } from './engine'
import { LevelMeter } from './LevelMeter'

function Select({ value, options, onChange, label, icon }: { value: string; options: DeviceInfo[]; onChange: (v: string) => void; label: string; icon: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-2 text-sm font-medium text-muted">
        {icon}
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-12 w-full rounded-xl border border-line bg-panel-2 px-3 text-[15px] outline-none focus:border-accent"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.kind === 'videoinput' ? describeCameraLabel(o.label) : o.label}
            {o.external ? ' · externa' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}

export function CalibrationPanel({ engine, onDone }: { engine: StudioEngine | null; onDone?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [info, setInfo] = useState(() => engine?.latencyInfo() ?? null)

  async function run() {
    if (!engine) return
    setBusy(true)
    setResult(null)
    try {
      await resumeAudio()
      const r = await engine.calibrate()
      setResult(r)
      setInfo(engine.latencyInfo())
      if (r.ok) onDone?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-2xl border border-line bg-panel-2 p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-bold">
          <IconHeadphones /> Calibrar sincronia
        </h3>
        {info ? (
          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${info.calibrated ? 'bg-ok/15 text-ok' : 'bg-accent/15 text-accent'}`}>
            {info.calibrated ? `${info.rtlMs.toFixed(0)} ms` : 'não calibrado'}
          </span>
        ) : null}
      </div>
      <p className="text-sm text-muted">
        O app toca alguns bipes e mede quanto tempo o som leva para sair e voltar pelo microfone. Com isso, cada nova faixa é encaixada no tempo exato.
      </p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted">
        <li>Coloque o fone que você vai usar (com fio) encostado no microfone do tablet — ou use o alto-falante com volume alto.</li>
        <li>Fique em silêncio e toque em “Calibrar”. Leva uns 7 segundos.</li>
        <li>Calibre de novo se trocar de fone ou de microfone.</li>
      </ol>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="primary" onClick={run} loading={busy} disabled={!engine?.hasStream}>
          Calibrar
        </Button>
        {result ? (
          <span className={`flex items-center gap-1.5 text-sm font-medium ${result.ok ? 'text-ok' : 'text-rec'}`}>
            {result.ok ? <IconCheck size={18} /> : <IconWarning size={18} />}
            {result.message}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function DevicesSheet({
  open,
  onClose,
  engine,
  selection,
  onSelection,
  monitor,
  onMonitor,
  deviceError,
}: {
  open: boolean
  onClose: () => void
  engine: StudioEngine | null
  selection: DeviceSelection
  onSelection: (s: DeviceSelection) => void
  monitor: boolean
  onMonitor: (v: boolean) => void
  deviceError: string | null
}) {
  const nav = useNavigate()
  const [devices, setDevices] = useState<{ cameras: DeviceInfo[]; mics: DeviceInfo[] }>({ cameras: [], mics: [] })

  useEffect(() => {
    if (!open) return
    const load = () => void listDevices().then(setDevices).catch(() => undefined)
    load()
    navigator.mediaDevices?.addEventListener('devicechange', load)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', load)
  }, [open, engine?.hasStream])

  const stream = engine?.mediaStream ?? null
  const camId = stream?.getVideoTracks()[0]?.getSettings().deviceId ?? selection.cameraId ?? devices.cameras[0]?.id ?? ''
  const micId = stream?.getAudioTracks()[0]?.getSettings().deviceId ?? selection.micId ?? devices.mics[0]?.id ?? ''

  return (
    <Modal open={open} onClose={onClose} title="Câmera, microfone e sincronia" wide>
      <div className="space-y-4">
        {deviceError ? <p className="rounded-xl border border-rec/40 bg-rec/10 p-3 text-sm text-[#ffd2cd]">{deviceError}</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Câmera"
            icon={<IconCamera size={18} />}
            value={camId}
            options={devices.cameras}
            onChange={(id) => onSelection({ ...selection, cameraId: id })}
          />
          <Select label="Microfone" icon={<IconMic size={18} />} value={micId} options={devices.mics} onChange={(id) => onSelection({ ...selection, micId: id })} />
        </div>
        <p className="text-xs text-faint">
          Webcam USB: conecte (pelo hub USB-C, se precisar) e ela aparece na lista sozinha. Se não aparecer, abra o teste completo abaixo.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted">Qualidade</span>
            <Segmented
              value={selection.quality}
              onChange={(q) => onSelection({ ...selection, quality: q })}
              options={[
                { value: '720p', label: 'HD 720p' },
                { value: '1080p', label: 'Full HD' },
              ]}
            />
          </div>
          <div className="flex items-center gap-2 text-sm text-muted">
            Nível <LevelMeter engine={engine} className="w-32" />
          </div>
        </div>
        {stream ? <p className="text-xs text-faint">Em uso: {streamSummary(stream)}</p> : null}
        <Toggle
          checked={monitor}
          onChange={onMonitor}
          label="Ouvir meu microfone no fone"
          hint="Útil para voz. O navegador adiciona um pequeno atraso a esse retorno (não afeta a gravação)."
        />
        <CalibrationPanel engine={engine} />
        <div className="flex justify-end">
          <Button variant="ghost" onClick={() => nav('/diagnostico')}>
            Teste completo de câmeras e microfones
          </Button>
        </div>
      </div>
    </Modal>
  )
}
