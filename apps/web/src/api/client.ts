import type {
  AdminDashboard,
  AdminJob,
  CatalogItem,
  CatalogPage,
  CatalogSection,
  ClientCapabilities,
  EpisodeItem,
  LocalizedText,
  PlaybackAudioTrack,
  PlaybackSession,
  PlaybackState,
  PlaybackSubtitleTrack,
  QualityVariant,
  SeasonItem,
  TitleDetail,
} from '@/types'

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(/\/$/, '')
const SHOWCASE = import.meta.env.VITE_APP_EDITION === 'showcase'
const SHOWCASE_CATALOG_URL = import.meta.env.VITE_SHOWCASE_CATALOG_URL
const STATIC_SHOWCASE = SHOWCASE && Boolean(SHOWCASE_CATALOG_URL)
const ADMIN_CSRF_KEY = 'easy-stream-admin-csrf'
const ADMIN_EMAIL_KEY = 'easy-stream-admin-email'

export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

type JsonRecord = Record<string, unknown>

let showcaseSnapshotPromise: Promise<JsonRecord> | undefined
const showcaseSessions = new Map<string, PlaybackSession>()

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function number(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function boolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function localized(value: unknown, fallback?: unknown): LocalizedText {
  if (typeof value === 'string') return { fa: value, en: value }
  const source = record(value)
  const fa = text(source.fa) ?? text(source.faIR) ?? text(source.persian)
  const en = text(source.en) ?? text(source.enUS) ?? text(source.english) ?? text(fallback)
  return {
    ...(fa ? { fa } : {}),
    ...(en ? { en } : {}),
  }
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

async function showcaseSnapshot(signal?: AbortSignal): Promise<JsonRecord> {
  if (!SHOWCASE_CATALOG_URL) throw new ApiError('VITE_SHOWCASE_CATALOG_URL is not configured', 500, 'SHOWCASE_CATALOG_MISSING')
  showcaseSnapshotPromise ??= fetch(SHOWCASE_CATALOG_URL, { headers: { accept: 'application/json' } }).then(async (response) => {
    if (!response.ok) throw new ApiError(`Showcase catalog failed to load (${response.status})`, response.status, 'SHOWCASE_CATALOG_LOAD_FAILED')
    const snapshot = record(await response.json())
    if (number(snapshot.version) !== 1) throw new ApiError('Unsupported Showcase catalog version', 500, 'SHOWCASE_CATALOG_VERSION')
    return snapshot
  }).catch((error) => {
    showcaseSnapshotPromise = undefined
    throw error
  })
  const snapshot = await showcaseSnapshotPromise
  if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError')
  return snapshot
}

function normalizeVariant(input: unknown): QualityVariant {
  const item = record(input)
  return {
    id: text(item.id) ?? '',
    label: text(item.label) ?? `${number(item.height) ?? 0}p`,
    ...(number(item.width) ? { width: number(item.width) } : {}),
    ...(number(item.height) ? { height: number(item.height) } : {}),
    ...(text(item.videoCodec) ? { videoCodec: text(item.videoCodec) } : {}),
    compatibility: text(item.compatibility) ?? 'INVALID',
    available: boolean(item.available),
    isDefault: boolean(item.isDefault),
  }
}

function normalizeCatalogItem(input: unknown): CatalogItem {
  const item = record(input)
  const metadata = record(item.metadata)
  const titleValue = item.name ?? item.title ?? metadata.title
  const title = typeof titleValue === 'string'
    ? { fa: titleValue, en: text(item.titleEn ?? metadata.titleEn) ?? titleValue }
    : localized(titleValue, item.name ?? metadata.name)
  const id = text(item.id) ?? text(item.titleId) ?? text(item.mediaItemId) ?? ''
  const mediaItemId = text(item.resumeMediaItemId) ?? text(item.mediaItemId) ?? text(item.playableMediaItemId) ?? id
  const kindValue = (text(item.kind) ?? text(item.type) ?? 'MOVIE').toUpperCase()
  const posterUrl = text(item.posterUrl) ?? text(metadata.posterUrl) ?? text(record(item.images).poster)
  const backdropUrl = text(item.backdropUrl) ?? text(metadata.backdropUrl) ?? text(record(item.images).backdrop)

  return {
    id,
    mediaItemId,
    slug: text(item.slug) ?? id,
    kind: kindValue === 'SERIES' || kindValue === 'SHOW' ? 'SERIES' : 'MOVIE',
    title,
    overview: typeof (item.synopsis ?? item.overview ?? metadata.overview) === 'string'
      ? {
          fa: text(item.synopsis ?? item.overview ?? metadata.overview),
          en: text(item.overviewEn ?? metadata.overviewEn) ?? text(item.synopsis ?? item.overview ?? metadata.overview),
        }
      : localized(item.synopsis ?? item.overview ?? metadata.overview, item.description ?? metadata.description),
    ...(posterUrl ? { posterUrl } : {}),
    ...(backdropUrl ? { backdropUrl } : {}),
    ...(number(item.year ?? metadata.year) !== undefined ? { year: number(item.year ?? metadata.year) } : {}),
    ...(text(item.category) ? { category: text(item.category) } : {}),
    ...(text(item.categorySlug) ? { categorySlug: text(item.categorySlug) } : {}),
    ...(text(item.releaseWindow) ? { releaseWindow: text(item.releaseWindow) } : {}),
    variants: array(item.variants).map(normalizeVariant).filter((variant) => variant.id),
    ...(number(item.runtimeSeconds ?? item.durationSeconds) !== undefined
      ? { runtimeSeconds: number(item.runtimeSeconds ?? item.durationSeconds) }
      : {}),
    ...(number(item.seasonCount) !== undefined ? { seasonCount: number(item.seasonCount) } : {}),
    ...(number(item.episodeCount) !== undefined ? { episodeCount: number(item.episodeCount) } : {}),
    ...(text(item.compatibility) ? { compatibility: text(item.compatibility) } : {}),
    playable: item.playable === undefined ? Boolean(mediaItemId) : boolean(item.playable),
    ...(number(item.progress) !== undefined ? { progress: number(item.progress) } : {}),
  }
}

function normalizeEpisode(input: unknown, seasonNumber: number): EpisodeItem {
  const item = record(input)
  const id = text(item.id) ?? text(item.mediaItemId) ?? ''
  return {
    id,
    mediaItemId: text(item.mediaItemId) ?? id,
    number: number(item.number ?? item.episodeNumber) ?? 0,
    seasonNumber: number(item.seasonNumber) ?? seasonNumber,
    title: localized(item.name ?? item.title),
    overview: localized(item.synopsis ?? item.overview, item.description),
    ...(text(item.posterUrl ?? item.stillUrl) ? { posterUrl: text(item.posterUrl ?? item.stillUrl) } : {}),
    ...(number(item.durationSeconds ?? item.runtimeSeconds) !== undefined
      ? { durationSeconds: number(item.durationSeconds ?? item.runtimeSeconds) }
      : {}),
    published: item.published === undefined ? true : boolean(item.published),
    variants: array(item.variants).map(normalizeVariant).filter((variant) => variant.id),
  }
}

function normalizeSeason(input: unknown): SeasonItem {
  const item = record(input)
  const seasonNumber = number(item.number ?? item.seasonNumber) ?? 0
  return {
    number: seasonNumber,
    title: localized(item.title, `Season ${seasonNumber}`),
    episodes: array(item.episodes).map((episode) => normalizeEpisode(episode, seasonNumber)),
  }
}

function normalizeTitleDetail(payload: JsonRecord): TitleDetail {
  const base = normalizeCatalogItem(payload)
  const explicitSeasons = array(payload.seasons).map(normalizeSeason)
  const mediaItems = array(payload.mediaItems).map((entry) => record(entry))
  const groupedSeasons = new Map<number, EpisodeItem[]>()
  mediaItems.forEach((entry) => {
    const seasonNumber = number(entry.seasonNumber) ?? 0
    const episodes = groupedSeasons.get(seasonNumber) ?? []
    episodes.push(normalizeEpisode(entry, seasonNumber))
    groupedSeasons.set(seasonNumber, episodes)
  })
  const seasons = explicitSeasons.some((season) => season.episodes.length)
    ? explicitSeasons
    : [...groupedSeasons.entries()]
        .sort(([left], [right]) => left - right)
        .map(([seasonNumber, episodes]) => ({
          number: seasonNumber,
          title: { fa: `فصل ${seasonNumber}`, en: `Season ${seasonNumber}` },
          episodes: episodes.sort((left, right) => left.number - right.number),
        }))
  const firstPublishedMediaItem = mediaItems.find((item) => item.published !== false)
  const playableMediaItemId = text(payload.resumeMediaItemId)
    ?? text(payload.playableMediaItemId)
    ?? text(firstPublishedMediaItem?.id)
  return {
    ...base,
    mediaItemId: playableMediaItemId ?? '',
    genres: array(payload.genres).map((genre) => localized(genre, record(genre).name)),
    seasons,
    ...(playableMediaItemId ? { playableMediaItemId } : {}),
  }
}

function normalizeSubtitle(input: unknown, index: number): PlaybackSubtitleTrack {
  const item = record(input)
  const urls = record(item.urls)
  const language = text(item.language ?? item.lang) ?? 'und'
  const delivery = text(item.delivery ?? item.format)?.toUpperCase()
  const assUrl = text(item.assUrl) ?? text(urls.ass) ?? (delivery === 'ASS' || delivery === 'ASS_JASSUB' ? text(item.url) : undefined)
  const vttUrl = text(item.vttUrl) ?? text(urls.vtt) ?? (delivery === 'VTT' || delivery === 'WEBVTT' ? text(item.url) : undefined)
  return {
    id: text(item.id) ?? `subtitle-${index}`,
    language,
    label: text(item.label) ?? language.toUpperCase(),
    default: boolean(item.default ?? item.isDefault),
    forced: boolean(item.forced ?? item.isForced),
    ...(assUrl ? { assUrl } : {}),
    ...(vttUrl ? { vttUrl } : {}),
    fonts: array(item.fontUrls ?? item.fonts).flatMap((font) => (typeof font === 'string' ? [font] : [])),
  }
}

function normalizeAudio(input: unknown, index: number): PlaybackAudioTrack {
  const item = record(input)
  const language = text(item.language ?? item.lang) ?? 'und'
  return {
    id: text(item.id) ?? `audio-${index}`,
    language,
    label: text(item.label ?? item.name) ?? language.toUpperCase(),
    default: boolean(item.default ?? item.isDefault),
  }
}

function normalizeState(value: unknown): PlaybackState {
  const state = (text(value) ?? 'FAILED').toUpperCase()
  if (state === 'READY' || state === 'PREPARING' || state === 'UNSUPPORTED_CLIENT') return state
  if (state === 'PENDING' || state === 'BUILDING' || state === 'QUEUED') return 'PREPARING'
  return 'FAILED'
}

export function normalizePlaybackSession(input: unknown): PlaybackSession {
  const source = record(input)
  const payload = Object.keys(record(source.data)).length ? record(source.data) : source
  const trackObject = record(payload.tracks)
  const mixedTracks = array(payload.tracks)
  const id = text(payload.id) ?? text(payload.sessionId) ?? ''
  const manifestUrl = text(payload.manifestUrl) ?? text(payload.masterPlaylistUrl) ?? text(payload.url)
  const subtitleInputs = array(payload.subtitles ?? payload.subtitleTracks ?? trackObject.subtitles)
  const audioInputs = array(payload.audioTracks ?? payload.audio ?? trackObject.audio)
  if (!subtitleInputs.length) {
    subtitleInputs.push(...mixedTracks.filter((track) => {
      const kind = text(record(track).kind ?? record(track).type)?.toUpperCase()
      return kind === 'SUBTITLE' || kind === 'TEXT'
    }))
  }
  if (!audioInputs.length) {
    audioInputs.push(...mixedTracks.filter((track) => text(record(track).kind ?? record(track).type)?.toUpperCase() === 'AUDIO'))
  }
  const normalizedSubtitles = subtitleInputs.map(normalizeSubtitle)
  const mergedSubtitles = [...normalizedSubtitles.reduce((tracks, track) => {
    const key = track.id.replace(/[-_:]?(ass|webvtt|vtt)$/i, '') || track.language
    const existing = tracks.get(key) ?? [...tracks.values()].find((candidate) => candidate.language === track.language)
    if (existing) {
      if (track.assUrl) existing.assUrl = track.assUrl
      if (track.vttUrl) existing.vttUrl = track.vttUrl
      existing.fonts = [...new Set([...existing.fonts, ...track.fonts])]
    } else {
      tracks.set(key, track)
    }
    return tracks
  }, new Map<string, PlaybackSubtitleTrack>()).values()]

  return {
    id,
    state: normalizeState(payload.state ?? payload.status),
    mediaItemId: text(payload.mediaItemId) ?? '',
    ...(text(payload.variantId) ? { variantId: text(payload.variantId) } : {}),
    ...(text(payload.qualityLabel) ? { qualityLabel: text(payload.qualityLabel) } : {}),
    ...(manifestUrl ? { manifestUrl } : {}),
    ...(number(payload.durationSeconds ?? payload.duration) !== undefined
      ? { durationSeconds: number(payload.durationSeconds ?? payload.duration) }
      : {}),
    pollAfterMs: Math.max(500, number(payload.pollAfterMs) ?? 1_500),
    ...(number(payload.progress ?? payload.progressPercent) !== undefined
      ? { progress: number(payload.progress ?? payload.progressPercent) }
      : {}),
    ...(text(payload.message) ? { message: text(payload.message) } : {}),
    ...(text(payload.reasonCode ?? payload.code) ? { reasonCode: text(payload.reasonCode ?? payload.code) } : {}),
    ...(text(payload.expiresAt) ? { expiresAt: text(payload.expiresAt) } : {}),
    ...(text(payload.videoCodec) ? { videoCodec: text(payload.videoCodec) } : {}),
    ...(text(payload.audioCodec) ? { audioCodec: text(payload.audioCodec) } : {}),
    subtitles: mergedSubtitles,
    audioTracks: audioInputs.map(normalizeAudio),
  }
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  headers.set('accept', 'application/json')

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  })

  const contentType = response.headers.get('content-type') ?? ''
  const body: unknown = response.status === 204
    ? undefined
    : contentType.includes('application/json')
      ? await response.json()
      : await response.text()

  if (!response.ok) {
    const outerError = record(body)
    const error = Object.keys(record(outerError.error)).length ? record(outerError.error) : outerError
    throw new ApiError(
      text(error.message) ?? text(error.error) ?? `Request failed (${response.status})`,
      response.status,
      text(error.code ?? error.reasonCode),
    )
  }

  return body
}

function queryString(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') query.set(key, String(value))
  })
  const encoded = query.toString()
  return encoded ? `?${encoded}` : ''
}

function withSignal(signal: AbortSignal | undefined, init: RequestInit = {}): RequestInit {
  return signal ? { ...init, signal } : init
}

export const api = {
  async catalog(options: { cursor?: string; limit?: number; kind?: string; category?: string; year?: number; releaseWindow?: string } = {}, signal?: AbortSignal): Promise<CatalogPage> {
    if (STATIC_SHOWCASE) {
      const snapshot = await showcaseSnapshot(signal)
      let items = array(snapshot.titles).map(normalizeCatalogItem)
      if (options.kind) items = items.filter((item) => item.kind === options.kind)
      if (options.category) items = items.filter((item) => item.categorySlug === options.category)
      if (options.year) items = items.filter((item) => item.year === options.year)
      if (options.releaseWindow) items = items.filter((item) => item.releaseWindow === options.releaseWindow)
      const limit = options.limit ?? 40
      return { items: items.slice(0, limit), total: items.length }
    }
    const body = await request(`/catalog${queryString({ ...options })}`, withSignal(signal))
    const source = record(body)
    const payload = Object.keys(record(source.data)).length ? record(source.data) : source
    const rawItems = Array.isArray(body) ? body : array(payload.items ?? payload.results)
    const nextCursor = text(payload.nextCursor ?? record(payload.pagination).nextCursor)
    const total = number(payload.total ?? record(payload.pagination).total)
    return {
      items: rawItems.map(normalizeCatalogItem).filter((item) => item.id),
      ...(nextCursor ? { nextCursor } : {}),
      ...(total !== undefined ? { total } : {}),
    }
  },

  async catalogSections(limitPerSection = 12, signal?: AbortSignal): Promise<CatalogSection[]> {
    if (STATIC_SHOWCASE) {
      const snapshot = await showcaseSnapshot(signal)
      return array(snapshot.sections).map((input) => {
        const section = record(input)
        const items = array(section.items).map(normalizeCatalogItem).filter((item) => item.id)
        return { slug: text(section.slug) ?? '', name: text(section.name) ?? '', items: items.slice(0, limitPerSection), hasMore: items.length > limitPerSection }
      }).filter((section) => section.slug && section.items.length)
    }
    const body = record(await request(`/catalog/sections${queryString({ limitPerSection })}`, withSignal(signal)))
    return array(body.sections).map((input) => {
      const section = record(input)
      return {
        slug: text(section.slug) ?? '',
        name: text(section.name) ?? text(section.slug) ?? '',
        items: array(section.items).map(normalizeCatalogItem).filter((item) => item.id),
        hasMore: boolean(section.hasMore),
      }
    }).filter((section) => section.slug && section.items.length)
  },

  async search(term: string, signal?: AbortSignal): Promise<CatalogPage> {
    const body = await request(`/search${queryString({ q: term, limit: 40 })}`, withSignal(signal))
    const source = record(body)
    const payload = Object.keys(record(source.data)).length ? record(source.data) : source
    const rawItems = Array.isArray(body) ? body : array(payload.items ?? payload.results)
    return {
      items: rawItems.map(normalizeCatalogItem).filter((item) => item.id),
      ...(number(payload.total) !== undefined ? { total: number(payload.total) } : {}),
    }
  },

  async title(slug: string, signal?: AbortSignal): Promise<TitleDetail> {
    if (STATIC_SHOWCASE) {
      const snapshot = await showcaseSnapshot(signal)
      const payload = array(snapshot.titles).map(record).find((title) => text(title.slug) === slug)
      if (!payload) throw new ApiError('Title not found', 404, 'NOT_FOUND')
      return normalizeTitleDetail(payload)
    }
    const body = await request(`/titles/${encodeURIComponent(slug)}`, withSignal(signal))
    const source = record(body)
    const payload = Object.keys(record(source.data)).length ? record(source.data) : source
    return normalizeTitleDetail(payload)
  },

  async createPlaybackSession(
    mediaItemId: string,
    clientCapabilities: ClientCapabilities,
    variantId?: string,
    signal?: AbortSignal,
  ): Promise<PlaybackSession> {
    if (STATIC_SHOWCASE) {
      const snapshot = await showcaseSnapshot(signal)
      const defaults = record(snapshot.defaultVariantByMedia)
      const selectedVariantId = variantId ?? text(defaults[mediaItemId])
      const playback = selectedVariantId ? record(record(snapshot.playbackByVariant)[selectedVariantId]) : {}
      if (!selectedVariantId || text(playback.mediaItemId) !== mediaItemId) throw new ApiError('This media is not prepared for playback', 404, 'NOT_PREPARED')
      const id = crypto.randomUUID()
      const session = normalizePlaybackSession({
        id, state: 'READY', ...playback, pollAfterMs: 1000,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
      showcaseSessions.set(id, session)
      return session
    }
    const body = await request('/playback-sessions', withSignal(signal, {
      method: 'POST',
      body: JSON.stringify({ mediaItemId, ...(variantId ? { variantId } : {}), clientCapabilities }),
    }))
    const session = normalizePlaybackSession(body)
    return { ...session, mediaItemId: session.mediaItemId || mediaItemId }
  },

  async playbackSession(id: string, signal?: AbortSignal): Promise<PlaybackSession> {
    if (STATIC_SHOWCASE) {
      if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError')
      const session = showcaseSessions.get(id)
      if (!session) throw new ApiError('Playback session not found', 404, 'NOT_FOUND')
      return session
    }
    return normalizePlaybackSession(await request(`/playback-sessions/${encodeURIComponent(id)}`, withSignal(signal)))
  },

  async clientEvent(event: Record<string, unknown>): Promise<void> {
    if (STATIC_SHOWCASE) return
    await request('/client-events', { method: 'POST', body: JSON.stringify(event), keepalive: true })
  },

  async adminSession(signal?: AbortSignal): Promise<{ authenticated: boolean; name?: string }> {
    const csrfToken = typeof sessionStorage === 'undefined' ? undefined : sessionStorage.getItem(ADMIN_CSRF_KEY)
    if (!csrfToken) return { authenticated: false }
    try {
      await request('/admin/jobs', withSignal(signal))
      const email = typeof sessionStorage === 'undefined' ? undefined : sessionStorage.getItem(ADMIN_EMAIL_KEY) ?? undefined
      return { authenticated: true, ...(email ? { name: email } : {}) }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return { authenticated: false }
      throw error
    }
  },

  async adminLogin(email: string, password: string, totp?: string): Promise<void> {
    const body = record(await request('/admin/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, ...(totp ? { totp } : {}) }),
    }))
    const csrfToken = text(body.csrfToken)
    if (!csrfToken) throw new ApiError('Administrator login did not return a CSRF token', 500, 'CSRF_TOKEN_MISSING')
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(ADMIN_CSRF_KEY, csrfToken)
      sessionStorage.setItem(ADMIN_EMAIL_KEY, text(record(body.admin).email) ?? email)
    }
  },

  async adminLogout(): Promise<void> {
    const csrfToken = typeof sessionStorage === 'undefined' ? undefined : sessionStorage.getItem(ADMIN_CSRF_KEY)
    try {
      await request('/admin/logout', {
        method: 'POST',
        ...(csrfToken ? { headers: { 'x-csrf-token': csrfToken } } : {}),
      })
    } finally {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(ADMIN_CSRF_KEY)
        sessionStorage.removeItem(ADMIN_EMAIL_KEY)
      }
    }
  },

  async adminDashboard(signal?: AbortSignal): Promise<AdminDashboard> {
    const [jobsBody, cacheBody, catalogBody] = await Promise.all([
      request('/admin/jobs', withSignal(signal)),
      request('/admin/cache', withSignal(signal)),
      request('/catalog?limit=100', withSignal(signal)),
    ])
    const jobsPayload = record(jobsBody)
    const cache = record(cacheBody)
    const catalog = record(catalogBody)
    const jobs: AdminJob[] = array(jobsPayload.items ?? jobsPayload.jobs).map((input, index) => {
      const item = record(input)
      const rawProgress = number(item.progress)
      return {
        id: text(item.id) ?? `job-${index}`,
        type: text(item.type) ?? 'UNKNOWN',
        state: text(item.state ?? item.status) ?? 'UNKNOWN',
        ...(rawProgress !== undefined ? { progress: rawProgress <= 1 ? rawProgress * 100 : rawProgress } : {}),
        ...(text(item.message ?? item.error) ? { message: text(item.message ?? item.error) } : {}),
        ...(text(item.createdAt) ? { createdAt: text(item.createdAt) } : {}),
      }
    })
    const catalogItems = array(catalog.items)
    return {
      catalogCount: catalogItems.length,
      publishedCount: catalogItems.filter((item) => record(item).playable === true).length,
      reviewCount: 0,
      activeJobs: jobs.filter((job) => job.state === 'RUNNING' || job.state === 'QUEUED').length,
      ...(number(cache.usedBytes) !== undefined
        ? { cacheUsedBytes: number(cache.usedBytes) }
        : {}),
      ...(number(cache.maxBytes) !== undefined
        ? { cacheCapacityBytes: number(cache.maxBytes) }
        : {}),
      jobs,
    }
  },

  async startScan(): Promise<{ jobId?: string }> {
    const csrfToken = typeof sessionStorage === 'undefined' ? undefined : sessionStorage.getItem(ADMIN_CSRF_KEY)
    if (!csrfToken) throw new ApiError('Administrator session must be renewed', 401, 'ADMIN_SESSION_REQUIRED')
    const body = record(await request('/admin/scans', {
      method: 'POST',
      headers: { 'x-csrf-token': csrfToken },
      body: JSON.stringify({ full: true }),
    }))
    const jobId = text(body.id ?? body.jobId ?? record(body.data).jobId)
    return { ...(jobId ? { jobId } : {}) }
  },
}
