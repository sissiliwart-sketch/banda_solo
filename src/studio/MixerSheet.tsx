import type { ReactNode } from 'react'
import { Modal } from '../components/ui'
import type { Track } from '../data/types'

function Stepper({ value, unit, onChange, steps = [1, 10] }: { value: number; unit: string; onChange: (v: number) => void; steps?: number[] }) {
  const btn = 'h-9 min-w-10 rounded-lg bg-panel-3 px-2 text-sm font-semibold hover:bg-line'
  return (
    <div className="flex items-center gap-1">
      {[...steps].reverse().map((s) => (
        <button key={`-${s}`} className={btn} onClick={() => onChange(Math.round((value - s) * 10) / 10)}>
          −{s}
        </button>
      ))}
      <span className="tabular w-20 text-center text-sm font-bold">
        {value > 0 ? '+' : ''}
        {value.toFixed(Math.abs(value) < 10 && value % 1 !== 0 ? 1 : 0)} {unit}
      </span>
      {steps.map((s) => (
        <button key={`+${s}`} className={btn} onClick={() => onChange(Math.round((value + s) * 10) / 10)}>
          +{s}
        </button>
      ))}
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <span className="text-sm text-muted">{label}</span>
      {children}
    </div>
  )
}

const INSTRUMENTS = ['Violão', 'Guitarra', 'Baixo', 'Bateria', 'Teclado', 'Voz', 'Backing vocal', 'Percussão', 'Sax', 'Violino', 'Sanfona', 'Cavaquinho']

export function InstrumentChips({ value, onPick }: { value: string; onPick: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {INSTRUMENTS.map((i) => (
        <button
          key={i}
          onClick={() => onPick(i)}
          className={`h-8 rounded-full px-3 text-xs font-semibold transition ${value === i ? 'bg-accent text-black' : 'bg-panel-3 text-muted hover:text-text'}`}
        >
          {i}
        </button>
      ))}
    </div>
  )
}

export function TrackControls({ track, onChange }: { track: Track; onChange: (patch: Partial<Track>) => void }) {
  return (
    <div className="space-y-1">
      <Row label="Volume">
        <input
          type="range"
          min={0}
          max={1.5}
          step={0.01}
          value={track.volume}
          onChange={(e) => onChange({ volume: Number(e.target.value) })}
          className="w-48"
          aria-label="Volume"
        />
      </Row>
      <Row label="Esquerda / direita">
        <input
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={track.pan}
          onChange={(e) => onChange({ pan: Number(e.target.value) })}
          onDoubleClick={() => onChange({ pan: 0 })}
          className="w-48"
          aria-label="Pan"
        />
      </Row>
      <Row label="Sincronia do som (adiantar +)">
        <Stepper value={track.nudgeMs} unit="ms" onChange={(v) => onChange({ nudgeMs: v })} />
      </Row>
      <Row label="Sincronia da imagem (adiantar +)">
        <Stepper value={track.videoDelayMs} unit="ms" steps={[10, 40]} onChange={(v) => onChange({ videoDelayMs: v })} />
      </Row>
      <Row label="Espelhar imagem">
        <button
          onClick={() => onChange({ mirror: !track.mirror })}
          className={`h-9 rounded-lg px-3 text-sm font-semibold ${track.mirror ? 'bg-accent text-black' : 'bg-panel-3'}`}
        >
          {track.mirror ? 'Espelhada' : 'Normal'}
        </button>
      </Row>
    </div>
  )
}

export function MixerSheet({
  open,
  onClose,
  tracks,
  onChange,
}: {
  open: boolean
  onClose: () => void
  tracks: Track[]
  onChange: (id: string, patch: Partial<Track>) => void
}) {
  const sorted = [...tracks].sort((a, b) => a.slot - b.slot)
  return (
    <Modal open={open} onClose={onClose} title="Mixer" wide>
      {sorted.length === 0 ? (
        <p className="text-sm text-muted">Grave a primeira tela para usar o mixer.</p>
      ) : (
        <ul className="space-y-3">
          {sorted.map((t) => (
            <li key={t.id} className="rounded-2xl border border-line bg-panel-2 p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-panel-3 text-sm font-bold">{t.slot + 1}</span>
                <input
                  value={t.musicianName}
                  onChange={(e) => onChange(t.id, { musicianName: e.target.value })}
                  className="h-9 min-w-0 flex-1 rounded-lg bg-transparent px-2 font-bold outline-none focus:bg-panel-3"
                  aria-label="Nome do músico"
                  maxLength={60}
                />
                <input
                  value={t.instrument}
                  onChange={(e) => onChange(t.id, { instrument: e.target.value })}
                  className="h-9 w-32 rounded-lg bg-transparent px-2 text-muted outline-none focus:bg-panel-3"
                  aria-label="Instrumento"
                  placeholder="Instrumento"
                  maxLength={40}
                />
                <button
                  onClick={() => onChange(t.id, { muted: !t.muted })}
                  className={`h-9 w-10 rounded-lg text-sm font-bold ${t.muted ? 'bg-rec text-white' : 'bg-panel-3 text-muted'}`}
                  aria-pressed={t.muted}
                  title="Mudo"
                >
                  M
                </button>
                <button
                  onClick={() => onChange(t.id, { solo: !t.solo })}
                  className={`h-9 w-10 rounded-lg text-sm font-bold ${t.solo ? 'bg-accent text-black' : 'bg-panel-3 text-muted'}`}
                  aria-pressed={t.solo}
                  title="Solo"
                >
                  S
                </button>
              </div>
              <TrackControls track={t} onChange={(p) => onChange(t.id, p)} />
              {t.syncQuality === 'estimated' ? (
                <p className="mt-1 text-xs text-accent">Sincronia estimada nesta faixa — confira e ajuste se precisar.</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
