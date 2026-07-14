<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { api } from '@/api/client'
import LoadingState from '@/components/LoadingState.vue'
import MediaCard from '@/components/MediaCard.vue'
import { useSpatialNavigation } from '@/composables/spatial-navigation'
import { useI18n } from '@/i18n'
import type { CatalogItem } from '@/types'

const route = useRoute()
const router = useRouter()
const root = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const term = ref(typeof route.query.q === 'string' ? route.query.q : '')
const items = ref<CatalogItem[]>([])
const loading = ref(false)
const searched = ref(Boolean(term.value))
const error = ref('')
const { t } = useI18n()
const { restoreFocus } = useSpatialNavigation(root, { restoreKey: 'search-focus' })
let timer: ReturnType<typeof setTimeout> | undefined
let controller: AbortController | undefined

async function search() {
  controller?.abort()
  const query = term.value.trim()
  void router.replace({ name: 'search', query: query ? { q: query } : {} })
  if (!query) {
    items.value = []
    searched.value = false
    loading.value = false
    return
  }
  controller = new AbortController()
  loading.value = true
  searched.value = true
  error.value = ''
  try {
    items.value = (await api.search(query, controller.signal)).items
    void restoreFocus()
  } catch (reason) {
    if ((reason as { name?: string }).name !== 'AbortError') {
      error.value = reason instanceof Error ? reason.message : t('networkError')
    }
  } finally {
    loading.value = false
  }
}

watch(term, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void search(), 300)
})

onMounted(async () => {
  if (term.value) await search()
  await nextTick()
  input.value?.focus()
})
onBeforeUnmount(() => {
  controller?.abort()
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <div ref="root" class="page-view search-view">
    <section class="page-heading">
      <p class="eyebrow">Easy Stream</p>
      <h1>{{ t('search') }}</h1>
      <div class="large-search">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" /></svg>
        <input
          ref="input"
          v-model="term"
          type="search"
          data-tv-focus
          data-focus-id="search-input"
          :placeholder="t('searchPlaceholder')"
          :aria-label="t('search')"
        />
      </div>
    </section>

    <LoadingState v-if="loading" :label="t('loading')" />
    <section v-else-if="error" class="center-state error-state" role="alert">
      <p>{{ error }}</p>
      <button class="primary-button focus-ring" type="button" data-tv-focus @click="search">{{ t('retry') }}</button>
    </section>
    <section v-else-if="items.length" class="catalog-section">
      <div class="media-grid"><MediaCard v-for="item in items" :key="item.id" :item="item" /></div>
    </section>
    <section v-else-if="searched" class="center-state"><h2>{{ t('noResults') }}</h2></section>
  </div>
</template>
