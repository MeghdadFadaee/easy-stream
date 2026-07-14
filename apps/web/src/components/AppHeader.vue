<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'

import BrandMark from '@/components/BrandMark.vue'
import { useI18n } from '@/i18n'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()
const router = useRouter()
const { language, t } = useI18n()
const searchTerm = ref('')

function submitSearch() {
  const query = searchTerm.value.trim()
  void router.push({ name: 'search', query: query ? { q: query } : {} })
}

function toggleLanguage() {
  void ui.setLanguage(language.value === 'fa' ? 'en' : 'fa')
}
</script>

<template>
  <header class="app-header">
    <RouterLink class="brand focus-ring" data-tv-focus data-focus-id="nav-home" to="/" :aria-label="t('home')">
      <BrandMark />
      <span class="brand-wordmark" aria-hidden="true">
        <span class="brand-easy">Easy</span><strong>Stream</strong>
      </span>
    </RouterLink>

    <nav class="primary-nav" :aria-label="t('home')">
      <RouterLink class="nav-link focus-ring" data-tv-focus data-focus-id="nav-catalog" to="/">
        {{ t('home') }}
      </RouterLink>
      <RouterLink class="nav-link focus-ring" data-tv-focus data-focus-id="nav-search" to="/search">
        {{ t('search') }}
      </RouterLink>
    </nav>

    <form class="header-search" role="search" @submit.prevent="submitSearch">
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" /></svg>
      <input
        v-model="searchTerm"
        data-tv-focus
        data-focus-id="header-search"
        :aria-label="t('search')"
        :placeholder="t('searchPlaceholder')"
      />
    </form>

    <button
      class="language-button focus-ring"
      type="button"
      data-tv-focus
      data-focus-id="language"
      :aria-label="t('language')"
      @click="toggleLanguage"
    >
      {{ t('switchLanguage') }}
    </button>
  </header>
</template>
