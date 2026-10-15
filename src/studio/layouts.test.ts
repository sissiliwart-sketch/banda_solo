import { describe, expect, it } from 'vitest'
import type { Aspect } from '../data/types'
import { coverCrop, distribute, getLayout, layoutsFor } from './layouts'

describe('layouts', () => {
  const aspects: Aspect[] = ['9:16', '1:1', '16:9']
  for (const aspect of aspects) {
    for (let n = 2; n <= 8; n++) {
      it(`${n} tiles in ${aspect} cover the frame exactly`, () => {
        const all = layoutsFor(n, aspect)
        expect(all.length).toBeGreaterThan(0)
        for (const l of all) {
          expect(l.tiles).toHaveLength(n)
          const area = l.tiles.reduce((s, t) => s + t.w * t.h, 0)
          expect(area).toBeCloseTo(1, 9)
          for (const t of l.tiles) {
            expect(t.x).toBeGreaterThanOrEqual(-1e-9)
            expect(t.y).toBeGreaterThanOrEqual(-1e-9)
            expect(t.x + t.w).toBeLessThanOrEqual(1 + 1e-9)
            expect(t.y + t.h).toBeLessThanOrEqual(1 + 1e-9)
          }
        }
      })
    }
  }

  it('distribute puts bigger groups last', () => {
    expect(distribute(5, 2)).toEqual([2, 3])
    expect(distribute(7, 3)).toEqual([2, 2, 3])
  })

  it('getLayout falls back to the best layout for unknown ids', () => {
    expect(getLayout('nope', 4, '1:1').tiles).toHaveLength(4)
  })

  it('prefers a 2x2 grid for 4 tiles in a square video', () => {
    expect(layoutsFor(4, '1:1')[0].name).toBe('Grade 2 × 2')
  })

  it('coverCrop crops the long side', () => {
    expect(coverCrop(1920, 1080, 100, 100)).toEqual({ sx: 420, sy: 0, sw: 1080, sh: 1080 })
    expect(coverCrop(1080, 1920, 200, 100)).toEqual({ sx: 0, sy: 690, sw: 1080, sh: 540 })
  })
})
