import type {
  AdminSessionResponse,
  AudioTrack,
  CacheStatus,
  CatalogCard,
  CatalogSection,
  CatalogQuery,
  ClientCapabilities,
  Job,
  MetadataCandidate,
  MediaCommand,
  PlaybackSession,
  SearchQuery,
  SubtitleTrack,
  TitleDetail,
} from '@easy-stream/contracts';

export interface MediaItemForPlayback {
  id: string;
  titleId: string;
  durationSeconds: number;
  compatibility: 'COPY' | 'AUDIO_TRANSCODE' | 'VIDEO_TRANSCODE' | 'HOLD_HDR' | 'INVALID';
  published: boolean;
  variants: Array<{
    id: string;
    label: string;
    height?: number;
    compatibility: 'COPY' | 'AUDIO_TRANSCODE' | 'VIDEO_TRANSCODE' | 'HOLD_HDR' | 'INVALID';
    available: boolean;
    isDefault: boolean;
  }>;
}

export interface CatalogPage {
  items: CatalogCard[];
  nextCursor?: string;
}

export interface CatalogRepository {
  listCatalog(query: CatalogQuery): Promise<CatalogPage>;
  listCatalogSections(limitPerSection: number): Promise<CatalogSection[]>;
  searchTitles(query: SearchQuery): Promise<CatalogCard[]>;
  getTitleBySlug(slug: string): Promise<TitleDetail | undefined>;
  getMediaItem(id: string): Promise<MediaItemForPlayback | undefined>;
  setMediaPublished(mediaItemId: string, published: boolean): Promise<boolean>;
  applyTitleMetadata(titleId: string, metadata: MetadataCandidate): Promise<boolean>;
}

export interface StoredPlaybackSession extends PlaybackSession {
  capabilities: ClientCapabilities;
}

export interface PlaybackRepository {
  createPlaybackSession(session: StoredPlaybackSession): Promise<void>;
  getPlaybackSession(id: string): Promise<StoredPlaybackSession | undefined>;
  updatePlaybackSession(session: StoredPlaybackSession): Promise<void>;
}

export interface AdminRecord {
  id: string;
  email: string;
  passwordHash: string;
  totpSecretEncrypted?: string;
  disabled: boolean;
}

export interface StoredAdminSession {
  id: string;
  adminId: string;
  tokenHash: string;
  csrfTokenHash: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface AdminRepository {
  findAdminByEmail(email: string): Promise<AdminRecord | undefined>;
  findAdminById(id: string): Promise<AdminRecord | undefined>;
  createAdmin(admin: AdminRecord): Promise<void>;
  createAdminSession(session: StoredAdminSession): Promise<void>;
  findAdminSessionByTokenHash(tokenHash: string): Promise<StoredAdminSession | undefined>;
  revokeAdminSession(id: string): Promise<void>;
  createJob(job: Job, payload: Record<string, unknown>): Promise<void>;
  listJobs(): Promise<Job[]>;
  findJob(id: string): Promise<Job | undefined>;
  retryJob(id: string): Promise<Job | undefined>;
  getCacheStatus(): Promise<CacheStatus>;
}

export type AppRepository = CatalogRepository & PlaybackRepository & AdminRepository;

export interface MediaPreparation {
  state: PlaybackSession['state'];
  playable: boolean;
  generationId?: string;
  manifestPath?: string;
  reasonCode?: string;
  pollAfterMs?: number;
  durationSeconds?: number;
  audioTracks?: AudioTrack[];
  subtitleTracks?: SubtitleTrack[];
}

export interface MediaPreparationService {
  prepare(input: {
    sessionId: string;
    mediaItem: MediaItemForPlayback;
    variantId?: string;
    capabilities: ClientCapabilities;
    protectUntil?: string;
  }): Promise<MediaPreparation>;
  getStatus(input: {
    sessionId: string;
    mediaItem: MediaItemForPlayback;
    variantId?: string;
    protectUntil?: string;
  }): Promise<MediaPreparation>;
}

export interface MediaCommandPublisher {
  publish(command: MediaCommand): Promise<void>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export interface TotpVerifier {
  verify(encryptedSecret: string, code: string): Promise<boolean>;
}

export interface MetadataProvider {
  search(input: {
    query: string;
    kind: 'MOVIE' | 'SERIES';
    year?: number;
  }): Promise<MetadataCandidate[]>;
  getDetails(input: {
    externalId: number;
    kind: 'MOVIE' | 'SERIES';
  }): Promise<MetadataCandidate>;
}

export interface AuthenticatedAdmin extends AdminSessionResponse {
  sessionId: string;
  rawToken: string;
}
