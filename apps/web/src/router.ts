import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router'

import CatalogView from '@/views/CatalogView.vue'
import TitleView from '@/views/TitleView.vue'

const showcase = import.meta.env.VITE_APP_EDITION === 'showcase'
const staticShowcase = showcase && Boolean(import.meta.env.VITE_SHOWCASE_CATALOG_URL)

export const router = createRouter({
  history: staticShowcase ? createWebHashHistory() : createWebHistory(),
  scrollBehavior: (_to, _from, savedPosition) => savedPosition ?? { top: 0 },
  routes: [
    { path: '/', name: 'catalog', component: CatalogView },
    ...(!showcase ? [
      { path: '/search', name: 'search', component: () => import('@/views/SearchView.vue') },
      { path: '/browse/:category', name: 'browse', component: () => import('@/views/BrowseView.vue') },
    ] : []),
    { path: '/title/:slug', name: 'title', component: TitleView },
    ...(!showcase ? [{ path: '/admin', name: 'admin', component: () => import('@/views/AdminView.vue') }] : []),
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
