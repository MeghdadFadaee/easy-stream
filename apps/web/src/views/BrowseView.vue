<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api/client'
import LoadingState from '@/components/LoadingState.vue'
import MediaCard from '@/components/MediaCard.vue'
import { useSpatialNavigation } from '@/composables/spatial-navigation'
import { useI18n } from '@/i18n'
import type { CatalogItem } from '@/types'

const route = useRoute()
const root = ref<HTMLElement | null>(null)
const items = ref<CatalogItem[]>([])
const sourceItems = ref<CatalogItem[]>([])
const year = ref('')
const releaseWindow = ref('')
const loading = ref(true)
const error = ref('')
let controller: AbortController | undefined
const { t } = useI18n()
useSpatialNavigation(root, { restoreKey: 'browse-focus' })
const category = computed(() => String(route.params.category ?? ''))
const categoryName = computed(() => sourceItems.value[0]?.category ?? category.value)
const years = computed(() => [...new Set(sourceItems.value.map((item) => item.year).filter((value): value is number => value !== undefined))].sort((a, b) => b - a))
const windows = computed(() => [...new Set(sourceItems.value.map((item) => item.releaseWindow).filter((value): value is string => Boolean(value)))])

async function load() {
  controller?.abort()
  controller = new AbortController()
  loading.value = true
  error.value = ''
  try {
    const page = await api.catalog({
      category: category.value,
      limit: 100,
      ...(year.value ? { year: Number(year.value) } : {}),
      ...(releaseWindow.value ? { releaseWindow: releaseWindow.value } : {}),
    }, controller.signal)
    items.value = page.items
    if (!year.value && !releaseWindow.value) sourceItems.value = page.items
  } catch (reason) {
    if ((reason as { name?: string }).name !== 'AbortError') error.value = reason instanceof Error ? reason.message : t('networkError')
  } finally {
    loading.value = false
  }
}

watch([category, year, releaseWindow], () => void load(), { immediate: true })
onBeforeUnmount(() => controller?.abort())
</script>

<template>
  <main ref="root" class="browse-view">
    <header class="browse-header">
      <div><p class="eyebrow">{{ t('browse') }}</p><h1>{{ categoryName }}</h1></div>
      <div class="browse-filters">
        <select v-model="year" data-tv-focus class="focus-ring" :aria-label="t('year')">
          <option value="">{{ t('allYears') }}</option>
          <option v-for="value in years" :key="value" :value="String(value)">{{ value }}</option>
        </select>
        <select v-model="releaseWindow" data-tv-focus class="focus-ring" :aria-label="t('releaseWindow')">
          <option value="">{{ t('allSeasons') }}</option>
          <option v-for="value in windows" :key="value" :value="value">{{ value }}</option>
        </select>
      </div>
    </header>
    <LoadingState v-if="loading" :label="t('loadingCatalog')" />
    <section v-else-if="error" class="center-state error-state"><p>{{ error }}</p></section>
    <section v-else-if="items.length" class="media-grid">
      <MediaCard v-for="item in items" :key="item.id" :item="item" />
    </section>
    <section v-else class="center-state"><h2>{{ t('emptyCatalog') }}</h2></section>
  </main>
</template>
