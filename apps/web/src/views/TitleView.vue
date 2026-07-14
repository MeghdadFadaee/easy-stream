<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { api } from '@/api/client'
import LoadingState from '@/components/LoadingState.vue'
import { useSpatialNavigation } from '@/composables/spatial-navigation'
import { useI18n } from '@/i18n'
import { usePlayerStore } from '@/stores/player'
import type { EpisodeItem, TitleDetail } from '@/types'

const route = useRoute()
const router = useRouter()
const root = ref<HTMLElement | null>(null)
const detail = ref<TitleDetail | null>(null)
const loading = ref(true)
const error = ref('')
const player = usePlayerStore()
const { localize, t } = useI18n()
const { restoreFocus } = useSpatialNavigation(root, {
  restoreKey: 'title-focus',
  onBack: () => router.back(),
})
let controller: AbortController | undefined

const title = computed(() => detail.value ? localize(detail.value.title, detail.value.slug) : '')
const canPlayTitle = computed(() => Boolean(detail.value?.playable && (detail.value.playableMediaItemId ?? detail.value.mediaItemId)))

function playTitle() {
  const mediaItemId = detail.value?.playableMediaItemId ?? detail.value?.mediaItemId
  if (!detail.value || !mediaItemId) return
  player.play({
    mediaItemId,
    title: title.value,
    ...(detail.value.posterUrl ? { posterUrl: detail.value.posterUrl } : {}),
  })
}

function playEpisode(episode: EpisodeItem) {
  player.play({
    mediaItemId: episode.mediaItemId,
    title: `${title.value} · ${t('episode')} ${episode.number}`,
    ...(episode.posterUrl ? { posterUrl: episode.posterUrl } : {}),
  })
}

async function load() {
  controller?.abort()
  controller = new AbortController()
  loading.value = true
  error.value = ''
  try {
    detail.value = await api.title(String(route.params.slug), controller.signal)
    void restoreFocus()
  } catch (reason) {
    if ((reason as { name?: string }).name !== 'AbortError') {
      error.value = reason instanceof Error ? reason.message : t('networkError')
    }
  } finally {
    loading.value = false
  }
}

watch(() => route.params.slug, () => void load(), { immediate: true })
onBeforeUnmount(() => controller?.abort())
</script>

<template>
  <div ref="root" class="title-view">
    <LoadingState v-if="loading" :label="t('loading')" />
    <section v-else-if="error" class="center-state error-state" role="alert">
      <p>{{ error }}</p>
      <button class="primary-button focus-ring" type="button" data-tv-focus @click="load">{{ t('retry') }}</button>
    </section>
    <template v-else-if="detail">
      <section
        class="detail-hero"
        :style="detail.backdropUrl ? { backgroundImage: `url(${detail.backdropUrl})` } : undefined"
      >
        <div class="hero-scrim" />
        <button class="back-button focus-ring" type="button" data-tv-focus data-focus-id="detail-back" @click="router.back()">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>
          {{ t('back') }}
        </button>
        <div class="detail-copy">
          <p class="eyebrow">{{ detail.kind === 'SERIES' ? t('series') : t('movies') }}</p>
          <h1>{{ title }}</h1>
          <div class="detail-meta">
            <span v-if="detail.year">{{ detail.year }}</span>
            <span v-if="detail.runtimeSeconds">{{ Math.ceil(detail.runtimeSeconds / 60) }} {{ t('minutes') }}</span>
            <span v-for="genre in detail.genres" :key="localize(genre)">{{ localize(genre) }}</span>
          </div>
          <p v-if="localize(detail.overview)" class="hero-overview">{{ localize(detail.overview) }}</p>
          <button
            v-if="canPlayTitle"
            class="primary-button large focus-ring"
            type="button"
            data-tv-focus
            data-focus-id="detail-play"
            @click="playTitle"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
            {{ t('play') }}
          </button>
        </div>
      </section>

      <section v-for="season in detail.seasons" :key="season.number" class="episodes-section">
        <h2>{{ localize(season.title, `${t('season')} ${season.number}`) }}</h2>
        <div class="episode-list">
          <button
            v-for="episode in season.episodes"
            :key="episode.id"
            class="episode-row focus-ring"
            type="button"
            data-tv-focus
            :data-focus-id="`episode-${episode.id}`"
            :disabled="!episode.published"
            @click="playEpisode(episode)"
          >
            <span class="episode-number">{{ episode.number }}</span>
            <span class="episode-copy">
              <strong>{{ localize(episode.title, `${t('episode')} ${episode.number}`) }}</strong>
              <small v-if="episode.durationSeconds">{{ Math.ceil(episode.durationSeconds / 60) }} {{ t('minutes') }}</small>
            </span>
            <span class="episode-play" aria-hidden="true">▶</span>
          </button>
        </div>
      </section>
    </template>
  </div>
</template>
