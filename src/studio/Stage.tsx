import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Aspect } from '../data/types'
import { ASPECTS, type LayoutDef } from './layouts'

/** Mounts an externally-owned <video> element (owned by the engine) inside React. */
export function MountedVideo({ el }: { el: HTMLVideoElement | null }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = ref.current
    if (!host || !el) return
    host.appendChild(el)
    if (el.srcObject && el.paused) void el.play().catch(() => undefined)
    return () => {
      if (el.parentElement === host) host.removeChild(el)
    }
  }, [el])
  return <div ref={ref} className="h-full w-full" />
}

/** Fits a frame of the project's aspect ratio inside the available space. */
export function Stage({ aspect, layout, renderTile }: { aspect: Aspect; layout: LayoutDef; renderTile: (slot: number) => ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const a = ASPECTS[aspect]

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const update = () => {
      const r = el.getBoundingClientRect()
      const ar = a.w / a.h
      let w = r.width
      let h = w / ar
      if (h > r.height) {
        h = r.height
        w = h * ar
      }
      setSize({ w: Math.floor(w), h: Math.floor(h) })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [a.w, a.h])

  return (
    <div ref={boxRef} className="flex h-full w-full items-center justify-center">
      <div className="relative overflow-hidden rounded-2xl bg-[#07080b] shadow-2xl ring-1 ring-line" style={{ width: size.w, height: size.h }}>
        {layout.tiles.map((t, i) => (
          <div
            key={i}
            className="absolute p-[3px]"
            style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%`, width: `${t.w * 100}%`, height: `${t.h * 100}%` }}
          >
            {renderTile(i)}
          </div>
        ))}
      </div>
    </div>
  )
}
