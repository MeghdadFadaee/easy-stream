<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'

import AppHeader from '@/components/AppHeader.vue'
import BrandMark from '@/components/BrandMark.vue'
import PlayerShell from '@/components/PlayerShell.vue'
import { useSpatialNavigation } from '@/composables/spatial-navigation'

const appRoot = ref<HTMLElement | null>(null)
const router = useRouter()
const showcase = import.meta.env.VITE_APP_EDITION === 'showcase'
useSpatialNavigation(appRoot, { onBack: () => router.back() })
</script>

<template>
  <div ref="appRoot" class="app-shell">
    <AppHeader />
    <main id="main-content" class="main-content" tabindex="-1">
      <RouterView />
    </main>
    <footer class="app-footer">
      <span class="footer-brand">
        <BrandMark />
        <span>Easy Stream</span>
      </span>
      <template v-if="!showcase">
        <span class="footer-dot" aria-hidden="true">•</span>
        <RouterLink to="/admin">Admin</RouterLink>
      </template>
    </footer>
    <PlayerShell />
  </div>
</template>
