import { describe, expect, it, vi } from 'vitest'

import { moveSpatialFocus } from '@/composables/spatial-navigation'

function rect(left: number, top: number): DOMRect {
  return { left, top, right: left + 100, bottom: top + 60, width: 100, height: 60, x: left, y: top, toJSON: () => ({}) }
}

describe('moveSpatialFocus', () => {
  it('moves to the nearest element in the requested physical direction', () => {
    const root = document.createElement('div')
    const first = document.createElement('button')
    const right = document.createElement('button')
    const below = document.createElement('button')
    for (const button of [first, right, below]) {
      button.dataset.tvFocus = ''
      root.append(button)
    }
    document.body.append(root)
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(rect(0, 0))
    vi.spyOn(right, 'getBoundingClientRect').mockReturnValue(rect(180, 0))
    vi.spyOn(below, 'getBoundingClientRect').mockReturnValue(rect(0, 120))
    first.focus()

    expect(moveSpatialFocus(root, 'right')).toBe(true)
    expect(document.activeElement).toBe(right)
    expect(moveSpatialFocus(root, 'down')).toBe(true)
    expect(document.activeElement).toBe(below)
  })

  it('focuses the first TV target when focus starts outside the region', () => {
    const root = document.createElement('div')
    const button = document.createElement('button')
    button.dataset.tvFocus = ''
    root.append(button)
    document.body.append(root)

    expect(moveSpatialFocus(root, 'down')).toBe(true)
    expect(document.activeElement).toBe(button)
  })
})
