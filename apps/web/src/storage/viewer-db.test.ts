import { beforeEach, describe, expect, it } from 'vitest'

import {
  __resetMemoryStorageForTests,
  readPreferences,
  readProgress,
  writePreferences,
  writeProgress,
} from '@/storage/viewer-db'

describe('viewer storage', () => {
  beforeEach(() => __resetMemoryStorageForTests())

  it('persists viewer preferences without requiring an account', async () => {
    await writePreferences({
      uiLanguage: 'en',
      subtitleLanguage: 'en',
      audioLanguage: 'ja',
      volume: 0.7,
      muted: false,
    })

    await expect(readPreferences()).resolves.toMatchObject({ uiLanguage: 'en', subtitleLanguage: 'en', volume: 0.7 })
  })

  it('stores resume progress by media item', async () => {
    await writeProgress({
      mediaItemId: 'episode-1',
      positionSeconds: 640,
      durationSeconds: 1420,
      updatedAt: 10,
      completed: false,
    })

    await expect(readProgress('episode-1')).resolves.toMatchObject({ positionSeconds: 640, completed: false })
  })
})
