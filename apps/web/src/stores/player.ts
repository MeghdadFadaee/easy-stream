import { defineStore } from 'pinia'
import { markRaw } from 'vue'

export interface PlayRequest {
  mediaItemId: string
  title: string
  posterUrl?: string
}

export interface PlayerController {
  start(request: PlayRequest): void
  close(): void
}

export const usePlayerStore = defineStore('player', {
  state: () => ({
    visible: false,
    controller: undefined as PlayerController | undefined,
    current: undefined as PlayRequest | undefined,
  }),

  actions: {
    register(controller: PlayerController) {
      this.controller = markRaw(controller)
    },

    unregister(controller: PlayerController) {
      if (this.controller === controller) this.controller = undefined
    },

    play(request: PlayRequest) {
      this.current = request
      this.visible = true
      this.controller?.start(request)
    },

    close() {
      this.controller?.close()
      this.visible = false
    },
  },
})
