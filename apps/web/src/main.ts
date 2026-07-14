import '@fontsource/vazirmatn/400.css'
import '@fontsource/vazirmatn/700.css'
import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from '@/App.vue'
import { router } from '@/router'
import { useUiStore } from '@/stores/ui'
import '@/styles.css'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)
app.mount('#app')

void useUiStore(pinia).hydrate()
