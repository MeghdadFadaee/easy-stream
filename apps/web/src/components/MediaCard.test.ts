import { createPinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import MediaCard from '@/components/MediaCard.vue'
import { usePlayerStore } from '@/stores/player'
import type { CatalogItem } from '@/types'

const item: CatalogItem = {
  id: 'title-1',
  mediaItemId: 'media-1',
  slug: 'sample-title',
  kind: 'MOVIE',
  title: { fa: 'فیلم نمونه', en: 'Sample movie' },
  overview: {},
  playable: true,
  year: 2026,
}

describe('MediaCard', () => {
  it('starts playback directly from the main card action', async () => {
    const pinia = createPinia()
    const start = vi.fn()
    const store = usePlayerStore(pinia)
    store.register({ start, close: vi.fn() })
    const wrapper = mount(MediaCard, {
      props: { item },
      global: {
        plugins: [pinia],
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
        },
      },
    })

    await wrapper.get('.media-card-play').trigger('click')

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ mediaItemId: 'media-1', title: 'فیلم نمونه' }))
    expect(store.visible).toBe(true)
  })

  it('disables direct play for unpublished media', () => {
    const pinia = createPinia()
    const wrapper = mount(MediaCard, {
      props: { item: { ...item, playable: false } },
      global: {
        plugins: [pinia],
        stubs: { RouterLink: { template: '<a><slot /></a>' } },
      },
    })

    expect(wrapper.get('.media-card-play').attributes('disabled')).toBeDefined()
  })
})
