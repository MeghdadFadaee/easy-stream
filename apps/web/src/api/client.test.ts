import { describe, expect, it } from 'vitest'

import { normalizePlaybackSession } from '@/api/client'

describe('normalizePlaybackSession', () => {
  it('normalizes the canonical playback response', () => {
    const session = normalizePlaybackSession({
      id: 'session-1',
      state: 'READY',
      manifestUrl: '/media/session-1/master.m3u8',
      durationSeconds: 1420,
      audioTracks: [{ id: 'audio-ja', language: 'ja', label: 'Japanese', default: true }],
      subtitleTracks: [{
        id: 'sub-fa',
        language: 'fa',
        label: 'فارسی',
        assUrl: '/subtitles/fa.ass',
        vttUrl: '/subtitles/fa.vtt',
        fontUrls: ['/fonts/one.ttf'],
      }],
    })

    expect(session.state).toBe('READY')
    expect(session.manifestUrl).toBe('/media/session-1/master.m3u8')
    expect(session.audioTracks[0]).toMatchObject({ language: 'ja', default: true })
    expect(session.subtitles[0]).toMatchObject({
      language: 'fa',
      assUrl: '/subtitles/fa.ass',
      vttUrl: '/subtitles/fa.vtt',
      fonts: ['/fonts/one.ttf'],
    })
  })

  it('splits and merges a legacy mixed track array', () => {
    const session = normalizePlaybackSession({
      sessionId: 'session-2',
      status: 'building',
      tracks: [
        { id: 'fa-ass', kind: 'SUBTITLE', language: 'fa', delivery: 'ASS', url: '/fa.ass' },
        { id: 'fa-vtt', kind: 'SUBTITLE', language: 'fa', delivery: 'WEBVTT', url: '/fa.vtt' },
        { id: 'ja', kind: 'AUDIO', language: 'ja', name: 'Japanese' },
      ],
    })

    expect(session.state).toBe('PREPARING')
    expect(session.subtitles).toHaveLength(1)
    expect(session.subtitles[0]).toMatchObject({ assUrl: '/fa.ass', vttUrl: '/fa.vtt' })
    expect(session.audioTracks).toHaveLength(1)
  })
})
