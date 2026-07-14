<script setup lang="ts">
import { computed } from 'vue'

import { useI18n } from '@/i18n'
import { usePlayerStore } from '@/stores/player'
import type { CatalogItem } from '@/types'

const props = defineProps<{
  item: CatalogItem
  progress?: number | undefined
}>()

const player = usePlayerStore()
const { localize, t } = useI18n()
const title = computed(() => localize(props.item.title, props.item.slug))
const effectiveProgress = computed(() => props.progress ?? props.item.progress ?? 0)

function play() {
  if (!props.item.playable || !props.item.mediaItemId) return
  player.play({
    mediaItemId: props.item.mediaItemId,
    ...(props.item.variants.length ? { variants: props.item.variants } : {}),
    title: title.value,
    ...(props.item.posterUrl ? { posterUrl: props.item.posterUrl } : {}),
  })
}
</script>

<template>
  <article class="media-card" :class="{ 'is-unavailable': !item.playable }">
    <button
      class="media-card-play focus-ring"
      type="button"
      data-tv-focus
      :data-focus-id="`media-${item.id}`"
      :disabled="!item.playable"
      :aria-label="`${effectiveProgress > 0 ? t('resume') : t('play')}: ${title}`"
      @click="play"
    >
      <img v-if="item.posterUrl" :src="item.posterUrl" alt="" loading="lazy" />
      <div v-else class="poster-placeholder" aria-hidden="true">
        <span>{{ title.slice(0, 1) }}</span>
      </div>
      <span class="card-gradient" aria-hidden="true" />
      <span class="card-play-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
      </span>
      <span v-if="!item.playable" class="availability-badge">{{ t('unavailable') }}</span>
      <span v-if="effectiveProgress > 0" class="progress-track" aria-hidden="true">
        <span :style="{ width: `${Math.min(100, Math.max(0, effectiveProgress))}%` }" />
      </span>
    </button>
    <div class="card-copy">
      <h3>{{ title }}</h3>
      <div class="card-meta">
        <span v-if="item.year">{{ item.year }}</span>
        <span>{{ item.kind === 'SERIES' ? t('series') : t('movies') }}</span>
      </div>
      <RouterLink
        class="card-info focus-ring"
        data-tv-focus
        :data-focus-id="`info-${item.id}`"
        :to="{ name: 'title', params: { slug: item.slug } }"
      >
        {{ t('details') }}
      </RouterLink>
    </div>
  </article>
</template>
