import { useEffect, useRef } from 'react'
import type { StudioEngine } from './engine'

/** Microphone input meter; updates the DOM directly to avoid re-rendering React at audio rate. */
export function LevelMeter({ engine, className = '' }: { engine: StudioEngine | null; className?: string }) {
  const bar = useRef<HTMLDivElement>(null)
  const clip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!engine) return
    let peakHold = 0
    let clipUntil = 0
    return engine.on('level', ({ peak }) => {
      peakHold = Math.max(peak, peakHold * 0.85)
      const db = 20 * Math.log10(Math.max(1e-5, peakHold))
      const frac = Math.min(1, Math.max(0, (db + 60) / 60))
      if (bar.current) {
        bar.current.style.width = `${frac * 100}%`
        bar.current.style.background = db > -3 ? '#ff4d3d' : db > -12 ? '#ffb020' : '#3ddc97'
      }
      if (peak >= 0.99) clipUntil = performance.now() + 1500
      if (clip.current) clip.current.style.opacity = performance.now() < clipUntil ? '1' : '0'
    })
  }, [engine])
  return (
    <div className={`relative h-2 w-24 overflow-hidden rounded-full bg-panel-3 ${className}`} title="Nível do microfone">
      <div ref={bar} className="h-full w-0 rounded-full transition-[width] duration-75" />
      <div ref={clip} className="absolute inset-y-0 right-0 w-1.5 bg-rec opacity-0" />
    </div>
  )
}
