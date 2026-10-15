import type { Aspect, ProjectSettings } from '../data/types'
import { ASPECTS, layoutsFor, MAX_SLOTS, MIN_SLOTS } from '../studio/layouts'
import { LayoutThumb } from './LayoutThumb'
import { IconPlus } from './icons'
import { Field, Segmented, Toggle } from './ui'

export const DEFAULT_SETTINGS: ProjectSettings = {
  title: '',
  slots: 4,
  layoutId: '',
  aspect: '9:16',
  bpm: 100,
  beatsPerBar: 4,
  countInBars: 1,
  metronome: false,
}

function AspectCard({ aspect, selected, onClick }: { aspect: Aspect; selected: boolean; onClick: () => void }) {
  const a = ASPECTS[aspect]
  const h = 56
  const w = (h * a.w) / a.h
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      className={`flex flex-1 flex-col items-center gap-2 rounded-2xl border p-3 transition ${selected ? 'border-accent bg-accent/10' : 'border-line hover:bg-panel-3'}`}
    >
      <div className="flex h-14 items-center">
        <div className={`rounded-md border-2 ${selected ? 'border-accent' : 'border-muted'}`} style={{ width: w, height: h }} />
      </div>
      <span className="text-sm font-bold">{a.label}</span>
      <span className="text-center text-[11px] leading-tight text-faint">{a.hint}</span>
    </button>
  )
}

/** Shared by "Nova música" and the studio settings sheet. */
export function ProjectSettingsForm({
  value,
  onChange,
  minSlots = MIN_SLOTS,
}: {
  value: ProjectSettings
  onChange: (v: ProjectSettings) => void
  minSlots?: number
}) {
  const layouts = layoutsFor(value.slots, value.aspect)
  const layoutId = layouts.some((l) => l.id === value.layoutId) ? value.layoutId : layouts[0].id
  const set = (patch: Partial<ProjectSettings>) => {
    const next = { ...value, ...patch }
    const ls = layoutsFor(next.slots, next.aspect)
    // Changing the number of screens or the format picks the best arrangement for it.
    if ('slots' in patch || 'aspect' in patch || !ls.some((l) => l.id === next.layoutId)) next.layoutId = ls[0].id
    onChange(next)
  }

  return (
    <div className="space-y-6">
      <Field label="Nome da música" value={value.title} onChange={(e) => set({ title: e.target.value })} placeholder="Ex.: Asa Branca" maxLength={120} />

      <section>
        <h3 className="mb-2 text-sm font-medium text-muted">Quantas telas (instrumentos)?</h3>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: MAX_SLOTS - MIN_SLOTS + 1 }, (_, i) => i + MIN_SLOTS).map((n) => (
            <button
              key={n}
              disabled={n < minSlots}
              onClick={() => set({ slots: n })}
              className={`h-12 w-12 rounded-xl text-lg font-bold transition disabled:opacity-30 ${n === value.slots ? 'bg-accent text-black' : 'bg-panel-2 hover:bg-panel-3'}`}
            >
              {n}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium text-muted">Formato do vídeo final</h3>
        <div className="flex gap-2">
          {(Object.keys(ASPECTS) as Aspect[]).map((a) => (
            <AspectCard key={a} aspect={a} selected={value.aspect === a} onClick={() => set({ aspect: a })} />
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium text-muted">Arrumação das telas</h3>
        <div className="-mx-1 flex gap-1 overflow-x-auto pb-2">
          {layouts.map((l) => (
            <LayoutThumb key={l.id} layout={l} aspect={value.aspect} selected={l.id === layoutId} onClick={() => set({ layoutId: l.id })} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-muted">Andamento e metrônomo</h3>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center rounded-xl bg-panel-2">
            <button className="h-12 w-12 text-xl font-bold" onClick={() => set({ bpm: Math.max(30, value.bpm - 1) })} aria-label="Diminuir BPM">
              −
            </button>
            <input
              type="number"
              inputMode="numeric"
              min={30}
              max={260}
              value={value.bpm}
              onChange={(e) => set({ bpm: Math.max(30, Math.min(260, Number(e.target.value) || 100)) })}
              className="tabular h-12 w-16 bg-transparent text-center text-lg font-bold outline-none"
              aria-label="BPM"
            />
            <button className="h-12 w-12 text-xl font-bold" onClick={() => set({ bpm: Math.min(260, value.bpm + 1) })} aria-label="Aumentar BPM">
              <IconPlus size={18} className="mx-auto" />
            </button>
          </div>
          <span className="text-sm text-muted">BPM</span>
          <Segmented
            value={value.beatsPerBar}
            onChange={(v) => set({ beatsPerBar: v })}
            options={[
              { value: 2, label: '2/4' },
              { value: 3, label: '3/4' },
              { value: 4, label: '4/4' },
              { value: 6, label: '6/8' },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted">Contagem antes de gravar:</span>
          <Segmented
            value={value.countInBars}
            onChange={(v) => set({ countInBars: v })}
            options={[
              { value: 0, label: 'Nenhuma' },
              { value: 1, label: '1 compasso' },
              { value: 2, label: '2 compassos' },
            ]}
          />
        </div>
        <Toggle
          checked={value.metronome}
          onChange={(v) => set({ metronome: v })}
          label="Metrônomo durante a gravação"
          hint="Toca só no seu fone — nunca entra no vídeo."
        />
      </section>
    </div>
  )
}
