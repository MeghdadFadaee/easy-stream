import { afterEach, vi } from 'vitest'

Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
  configurable: true,
  get() {
    return this.parentElement
  },
})

if (typeof CSS === 'undefined') {
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/["\\]/g, '\\$&') })
}

HTMLElement.prototype.scrollIntoView = vi.fn()

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})
