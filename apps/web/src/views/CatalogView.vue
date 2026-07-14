<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { api } from '@/api/client'
import LoadingState from '@/components/LoadingState.vue'
import MediaCard from '@/components/MediaCard.vue'
import { useSpatialNavigation } from '@/composables/spatial-navigation'
import { useI18n } from '@/i18n'
import { listProgress } from '@/storage/viewer-db'
import { usePlayerStore } from '@/stores/player'
import type { CatalogItem, CatalogSection } from '@/types'

const root = ref<HTMLElement | null>(null)
const sections = ref<CatalogSection[]>([])
const progress = ref<Record<string, number>>({})
const loading = ref(true)
const error = ref('')
const { localize, t } = useI18n()
const player = usePlayerStore()
const items = computed(() => sections.value.flatMap((section) => section.items))
const featured = computed(() => items.value.find((item) => item.playable) ?? items.value[0])
const { restoreFocus } = useSpatialNavigation(root, { restoreKey: 'catalog-focus' })

function playFeatured() {
  const item = featured.value
  if (!item?.playable || !item.mediaItemId) return
  player.play({
    mediaItemId: item.mediaItemId,
    ...(item.variants.length ? { variants: item.variants } : {}),
    title: localize(item.title, item.slug),
    ...(item.posterUrl ? { posterUrl: item.posterUrl } : {}),
  })
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [catalogSections, storedProgress] = await Promise.all([api.catalogSections(12), listProgress()])
    sections.value = catalogSections
    progress.value = Object.fromEntries(storedProgress.map((entry) => [
      entry.mediaItemId,
      entry.durationSeconds > 0 ? (entry.positionSeconds / entry.durationSeconds) * 100 : 0,
    ]))
    void restoreFocus()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : t('networkError')
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())
</script>

<template>
  <div ref="root" class="catalog-view">
    <LoadingState v-if="loading" :label="t('loadingCatalog')" />

    <section v-else-if="error" class="center-state error-state" role="alert">
      <h1>{{ t('networkError') }}</h1>
      <p>{{ error }}</p>
      <button class="primary-button focus-ring" type="button" data-tv-focus @click="load">{{ t('retry') }}</button>
    </section>

    <template v-else-if="items.length">
      <section
        v-if="featured"
        class="hero"
        :style="featured.backdropUrl ? { backgroundImage: `url(${featured.backdropUrl})` } : undefined"
      >
        <div class="hero-scrim" />
        <div class="hero-content">
          <p class="eyebrow">{{ t('featured') }}</p>
          <h1>{{ localize(featured.title, featured.slug) }}</h1>
          <p v-if="localize(featured.overview)" class="hero-overview">{{ localize(featured.overview) }}</p>
          <div class="hero-actions">
            <button
              class="primary-button large focus-ring"
              type="button"
              data-tv-focus
              data-focus-id="featured-play"
              :disabled="!featured.playable"
              @click="playFeatured"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              {{ t('play') }}
            </button>
            <RouterLink
              class="secondary-button large focus-ring"
              data-tv-focus
              data-focus-id="featured-info"
              :to="{ name: 'title', params: { slug: featured.slug } }"
            >
              {{ t('details') }}
            </RouterLink>
          </div>
        </div>
      </section>

      <section v-for="section in sections" :key="section.slug" class="catalog-section">
        <div class="section-heading">
          <h2>{{ section.name }}</h2>
          <RouterLink class="secondary-button focus-ring" data-tv-focus :to="{ name: 'browse', params: { category: section.slug } }">
            {{ t('browseAll') }}
          </RouterLink>
        </div>
        <div class="media-grid category-rail">
          <MediaCard
            v-for="item in section.items"
            :key="item.id"
            :item="item"
            :progress="progress[item.mediaItemId]"
          />
        </div>
      </section>
    </template>

    <section v-else class="center-state">
      <h1>{{ t('emptyCatalog') }}</h1>
    </section>
  </div>
</template>
