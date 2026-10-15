import type { Aspect } from '../data/types'
import { ASPECTS, type LayoutDef } from '../studio/layouts'

export function LayoutThumb({ layout, aspect, selected, onClick, height = 96 }: { layout: LayoutDef; aspect: Aspect; selected?: boolean; onClick?: () => void; height?: number }) {
  const a = ASPECTS[aspect]
  const width = (height * a.w) / a.h
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      title={layout.name}
      className={`flex shrink-0 flex-col items-center gap-2 rounded-2xl p-2 transition ${selected ? 'bg-accent/15 ring-2 ring-accent' : 'hover:bg-panel-3'}`}
    >
      <div className="relative overflow-hidden rounded-lg bg-black" style={{ width, height }}>
        {layout.tiles.map((t, i) => (
          <div
            key={i}
            className="absolute flex items-center justify-center p-[1.5px]"
            style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%`, width: `${t.w * 100}%`, height: `${t.h * 100}%` }}
          >
            <div className={`flex h-full w-full items-center justify-center rounded-[3px] text-[10px] font-bold ${selected ? 'bg-accent/80 text-black' : 'bg-panel-3 text-muted'}`}>{i + 1}</div>
          </div>
        ))}
      </div>
      <span className="max-w-[9rem] truncate text-xs font-medium text-muted">{layout.name}</span>
    </button>
  )
}
