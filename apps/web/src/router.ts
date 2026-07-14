import { createRouter, createWebHistory } from 'vue-router'

import AdminView from '@/views/AdminView.vue'
import CatalogView from '@/views/CatalogView.vue'
import SearchView from '@/views/SearchView.vue'
import TitleView from '@/views/TitleView.vue'

export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: (_to, _from, savedPosition) => savedPosition ?? { top: 0 },
  routes: [
    { path: '/', name: 'catalog', component: CatalogView },
    { path: '/search', name: 'search', component: SearchView },
    { path: '/title/:slug', name: 'title', component: TitleView },
    { path: '/admin', name: 'admin', component: AdminView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
