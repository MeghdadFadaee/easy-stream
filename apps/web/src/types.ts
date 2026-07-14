export type UiLanguage = 'fa' | 'en'
export type MediaKind = 'MOVIE' | 'SERIES'

export interface LocalizedText {
  fa?: string | undefined
  en?: string | undefined
}

export interface QualityVariant {
  id: string
  label: string
  width?: number | undefined
  height?: number | undefined
  videoCodec?: string | undefined
  compatibility: string
  available: boolean
  isDefault: boolean
}

export interface CatalogItem {
  id: string
  mediaItemId: string
  slug: string
  kind: MediaKind
  title: LocalizedText
  overview: LocalizedText
  posterUrl?: string | undefined
  backdropUrl?: string | undefined
  year?: number | undefined
  category?: string | undefined
  categorySlug?: string | undefined
  releaseWindow?: string | undefined
  variants: QualityVariant[]
  runtimeSeconds?: number | undefined
  seasonCount?: number | undefined
  episodeCount?: number | undefined
  compatibility?: string | undefined
  playable: boolean
  progress?: number | undefined
}

export interface EpisodeItem {
  id: string
  mediaItemId: string
  number: number
  seasonNumber: number
  title: LocalizedText
  overview: LocalizedText
  posterUrl?: string | undefined
  durationSeconds?: number | undefined
  published: boolean
  variants: QualityVariant[]
}

export interface SeasonItem {
  number: number
  title: LocalizedText
  episodes: EpisodeItem[]
}

export interface TitleDetail extends CatalogItem {
  genres: LocalizedText[]
  seasons: SeasonItem[]
  playableMediaItemId?: string | undefined
}

export interface CatalogPage {
  items: CatalogItem[]
  nextCursor?: string | undefined
  total?: number | undefined
}

export interface CatalogSection {
  slug: string
  name: string
  items: CatalogItem[]
  hasMore: boolean
}

export type PlaybackState = 'PREPARING' | 'READY' | 'UNSUPPORTED_CLIENT' | 'FAILED'
export type SubtitleDelivery = 'ASS_JASSUB' | 'WEBVTT' | 'OFF'

export interface PlaybackSubtitleTrack {
  id: string
  language: string
  label: string
  default: boolean
  forced: boolean
  assUrl?: string | undefined
  vttUrl?: string | undefined
  fonts: string[]
}

export interface PlaybackAudioTrack {
  id: string
  language: string
  label: string
  default: boolean
}

export interface PlaybackSession {
  id: string
  state: PlaybackState
  mediaItemId: string
  variantId?: string | undefined
  qualityLabel?: string | undefined
  manifestUrl?: string | undefined
  durationSeconds?: number | undefined
  pollAfterMs: number
  progress?: number | undefined
  message?: string | undefined
  reasonCode?: string | undefined
  expiresAt?: string | undefined
  videoCodec?: string | undefined
  audioCodec?: string | undefined
  subtitles: PlaybackSubtitleTrack[]
  audioTracks: PlaybackAudioTrack[]
}

export interface ClientCapabilities {
  nativeHls: boolean
  mse: boolean
  hlsJs: boolean
  assRenderer: boolean
  supportedCodecs: string[]
  userAgent?: string | undefined
}

export interface ProgressRecord {
  mediaItemId: string
  positionSeconds: number
  durationSeconds: number
  updatedAt: number
  completed: boolean
}

export interface ViewerPreferences {
  uiLanguage: UiLanguage
  subtitleLanguage: string
  audioLanguage: string
  volume: number
  muted: boolean
  preferredQualityHeight: number
}

export interface AdminJob {
  id: string
  type: string
  state: string
  progress?: number | undefined
  message?: string | undefined
  createdAt?: string | undefined
}

export interface AdminDashboard {
  catalogCount: number
  publishedCount: number
  reviewCount: number
  activeJobs: number
  cacheUsedBytes?: number | undefined
  cacheCapacityBytes?: number | undefined
  jobs: AdminJob[]
}
