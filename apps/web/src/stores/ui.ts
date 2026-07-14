import { defineStore } from 'pinia'

import { defaultPreferences, readPreferences, writePreferences } from '@/storage/viewer-db'
import type { UiLanguage, ViewerPreferences } from '@/types'

function applyDocumentLanguage(language: UiLanguage): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = language
  document.documentElement.dir = language === 'fa' ? 'rtl' : 'ltr'
}

export const useUiStore = defineStore('ui', {
  state: () => ({
    preferences: { ...defaultPreferences } as ViewerPreferences,
    hydrated: false,
  }),

  actions: {
    async hydrate() {
      this.preferences = await readPreferences()
      this.hydrated = true
      applyDocumentLanguage(this.preferences.uiLanguage)
    },

    async setLanguage(language: UiLanguage) {
      this.preferences.uiLanguage = language
      applyDocumentLanguage(language)
      await writePreferences({ ...this.preferences })
    },

    async setSubtitleLanguage(language: string) {
      this.preferences.subtitleLanguage = language
      await writePreferences({ ...this.preferences })
    },

    async setAudioLanguage(language: string) {
      this.preferences.audioLanguage = language
      await writePreferences({ ...this.preferences })
    },

    async setVolume(volume: number, muted: boolean) {
      this.preferences.volume = Math.min(1, Math.max(0, volume))
      this.preferences.muted = muted
      await writePreferences({ ...this.preferences })
    },
  },
})
