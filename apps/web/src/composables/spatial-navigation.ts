import { nextTick, onBeforeUnmount, onMounted, type Ref } from 'vue'

type Direction = 'left' | 'right' | 'up' | 'down'

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
}

function candidates(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-tv-focus]:not([disabled])')]
    .filter((element) => element.offsetParent !== null && element.getAttribute('aria-hidden') !== 'true')
}

function scoreCandidate(current: DOMRect, candidate: DOMRect, direction: Direction): number | undefined {
  const currentX = current.left + current.width / 2
  const currentY = current.top + current.height / 2
  const candidateX = candidate.left + candidate.width / 2
  const candidateY = candidate.top + candidate.height / 2
  const dx = candidateX - currentX
  const dy = candidateY - currentY

  if (direction === 'left' && dx >= -1) return undefined
  if (direction === 'right' && dx <= 1) return undefined
  if (direction === 'up' && dy >= -1) return undefined
  if (direction === 'down' && dy <= 1) return undefined

  const primary = direction === 'left' || direction === 'right' ? Math.abs(dx) : Math.abs(dy)
  const secondary = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx)
  return primary + secondary * 2.25
}

export function moveSpatialFocus(root: HTMLElement, direction: Direction): boolean {
  const focusable = candidates(root)
  if (!focusable.length) return false
  const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement)
    ? document.activeElement
    : undefined
  if (!active) {
    focusable[0]?.focus()
    return true
  }

  const currentRect = active.getBoundingClientRect()
  const ranked = focusable
    .filter((element) => element !== active)
    .map((element) => ({ element, score: scoreCandidate(currentRect, element.getBoundingClientRect(), direction) }))
    .filter((result): result is { element: HTMLElement; score: number } => result.score !== undefined)
    .sort((left, right) => left.score - right.score)
  const next = ranked[0]?.element
  if (!next) return false
  next.focus()
  next.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  return true
}

export function useSpatialNavigation(
  root: Ref<HTMLElement | null>,
  options: { onBack?: () => void; restoreKey?: string } = {},
) {
  const onKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    const element = root.value
    if (!element || element.offsetParent === null || isTypingTarget(event.target)) return
    const directionByKey: Partial<Record<string, Direction>> = {
      ArrowLeft: 'left',
      ArrowRight: 'right',
      ArrowUp: 'up',
      ArrowDown: 'down',
    }
    const direction = directionByKey[event.key]
    if (direction && moveSpatialFocus(element, direction)) {
      event.preventDefault()
      return
    }
    if ((event.key === 'Escape' || event.key === 'BrowserBack' || event.key === 'Backspace') && options.onBack) {
      event.preventDefault()
      options.onBack()
    }
  }

  const rememberFocus = (event: FocusEvent) => {
    const target = event.target
    if (options.restoreKey && target instanceof HTMLElement && target.dataset.focusId) {
      sessionStorage.setItem(options.restoreKey, target.dataset.focusId)
    }
  }

  const restoreFocus = async () => {
    await nextTick()
    const element = root.value
    if (!element) return
    const id = options.restoreKey ? sessionStorage.getItem(options.restoreKey) : undefined
    const escapedId = id && typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id
    const previous = escapedId ? element.querySelector<HTMLElement>(`[data-focus-id="${escapedId}"]`) : undefined
    ;(previous ?? candidates(element)[0])?.focus()
  }

  onMounted(() => {
    document.addEventListener('keydown', onKeydown)
    root.value?.addEventListener('focusin', rememberFocus)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKeydown)
    root.value?.removeEventListener('focusin', rememberFocus)
  })

  return { restoreFocus }
}
