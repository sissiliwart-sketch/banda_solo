import type { Aspect } from '../data/types'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface LayoutDef {
  id: string
  name: string
  tiles: Rect[]
}

export const ASPECTS: Record<Aspect, { w: number; h: number; label: string; hint: string }> = {
  '9:16': { w: 1080, h: 1920, label: 'Vertical', hint: 'Reels, TikTok, Shorts, Status' },
  '1:1': { w: 1080, h: 1080, label: 'Quadrado', hint: 'Feed do Instagram e Facebook' },
  '16:9': { w: 1920, h: 1080, label: 'Horizontal', hint: 'YouTube, TV, computador' },
}

export const MIN_SLOTS = 2
export const MAX_SLOTS = 8

/** Splits n items into `groups` near-equal counts, larger groups last (e.g. 5 in 2 -> [2, 3]). */
export function distribute(n: number, groups: number): number[] {
  const base = Math.floor(n / groups)
  const extra = n % groups
  return Array.from({ length: groups }, (_, i) => base + (i >= groups - extra ? 1 : 0))
}

function rowsLayout(counts: number[], area: Rect = { x: 0, y: 0, w: 1, h: 1 }): Rect[] {
  const tiles: Rect[] = []
  const rh = area.h / counts.length
  counts.forEach((c, r) => {
    const cw = area.w / c
    for (let i = 0; i < c; i++) tiles.push({ x: area.x + i * cw, y: area.y + r * rh, w: cw, h: rh })
  })
  return tiles
}

function colsLayout(counts: number[], area: Rect = { x: 0, y: 0, w: 1, h: 1 }): Rect[] {
  const tiles: Rect[] = []
  const cw = area.w / counts.length
  counts.forEach((c, col) => {
    const rh = area.h / c
    for (let i = 0; i < c; i++) tiles.push({ x: area.x + col * cw, y: area.y + i * rh, w: cw, h: rh })
  })
  // Reading order: row by row, so sort by y then x.
  return tiles.sort((a, b) => (Math.abs(a.y - b.y) < 1e-9 ? a.x - b.x : a.y - b.y))
}

function tileAspect(t: Rect, aspect: Aspect): number {
  const a = ASPECTS[aspect]
  return (t.w * a.w) / (t.h * a.h)
}

/** Lower is better: how far tiles are from a pleasant 3:4 … 4:3 shape (cropping less of the camera). */
function score(tiles: Rect[], aspect: Aspect): number {
  let s = 0
  for (const t of tiles) {
    const ar = tileAspect(t, aspect)
    const d = ar < 0.75 ? Math.log(0.75 / ar) : ar > 1.34 ? Math.log(ar / 1.34) : 0
    s += d
  }
  // Prefer uniform tiles slightly.
  const areas = tiles.map((t) => t.w * t.h)
  const spread = Math.max(...areas) / Math.min(...areas)
  return s / tiles.length + Math.log(spread) * 0.15
}

function key(tiles: Rect[]): string {
  return tiles.map((t) => [t.x, t.y, t.w, t.h].map((v) => v.toFixed(4)).join(',')).join('|')
}

function rowsName(counts: number[]): string {
  if (counts.length === 1) return `${counts[0]} lado a lado`
  if (counts.every((c) => c === 1)) return `${counts.length} empilhadas`
  if (counts.every((c) => c === counts[0])) return `Grade ${counts[0]} × ${counts.length}`
  return `Linhas ${counts.join(' + ')}`
}

function colsName(counts: number[]): string {
  if (counts.every((c) => c === counts[0])) return `Grade ${counts.length} × ${counts[0]}`
  return `Colunas ${counts.join(' + ')}`
}

export function layoutsFor(n: number, aspect: Aspect): LayoutDef[] {
  const out: (LayoutDef & { score: number })[] = []
  const seen = new Set<string>()
  const add = (id: string, name: string, tiles: Rect[]) => {
    const k = key(tiles)
    if (seen.has(k) || tiles.length !== n) return
    seen.add(k)
    out.push({ id, name, tiles, score: score(tiles, aspect) })
  }
  for (let r = 1; r <= Math.min(n, 4); r++) {
    const counts = distribute(n, r)
    if (Math.max(...counts) > 4) continue
    add(`rows-${counts.join('-')}`, rowsName(counts), rowsLayout(counts))
  }
  for (let c = 2; c <= Math.min(n, 4); c++) {
    const counts = distribute(n, c)
    if (Math.max(...counts) > 4) continue
    add(`cols-${counts.join('-')}`, colsName(counts), colsLayout(counts))
  }
  if (n >= 3) {
    // One big "featured" tile (e.g. the lead singer) plus the band.
    const rest = n - 1
    const restRows = rest <= 3 ? 1 : 2
    const topH = aspect === '9:16' ? 0.5 : 0.6
    const featTop = [{ x: 0, y: 0, w: 1, h: topH }, ...rowsLayout(distribute(rest, restRows), { x: 0, y: topH, w: 1, h: 1 - topH })]
    add('feat-top', 'Destaque em cima', featTop)
    if (aspect !== '9:16') {
      const leftW = 0.5
      const restCols = rest <= 3 ? 1 : 2
      const featLeft = [{ x: 0, y: 0, w: leftW, h: 1 }, ...colsLayout(distribute(rest, restCols), { x: leftW, y: 0, w: 1 - leftW, h: 1 })]
      add('feat-left', 'Destaque à esquerda', featLeft)
    }
  }
  return out.sort((a, b) => a.score - b.score).map(({ id, name, tiles }) => ({ id, name, tiles }))
}

export function getLayout(id: string, n: number, aspect: Aspect): LayoutDef {
  const all = layoutsFor(n, aspect)
  return all.find((l) => l.id === id) ?? all[0]
}

export function defaultLayoutId(n: number, aspect: Aspect): string {
  return layoutsFor(n, aspect)[0].id
}

/** Source rectangle (in source pixels) that covers a destination box without distortion. */
export function coverCrop(srcW: number, srcH: number, dstW: number, dstH: number): { sx: number; sy: number; sw: number; sh: number } {
  const srcAr = srcW / srcH
  const dstAr = dstW / dstH
  if (srcAr > dstAr) {
    const sw = srcH * dstAr
    return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH }
  }
  const sh = srcW / dstAr
  return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh }
}
