import { randomUUID } from 'node:crypto';
import type {
  ClientCapabilities,
  CreatePlaybackSession,
  PlaybackSession,
} from '@easy-stream/contracts';
import type { ApiConfig } from '../config.js';
import type {
  AppRepository,
  MediaItemForPlayback,
  MediaPreparation,
  MediaPreparationService,
  StoredPlaybackSession,
} from '../domain.js';
import { AppError } from '../errors.js';

export class PlaybackService {
  constructor(
    private readonly repository: AppRepository,
    private readonly media: MediaPreparationService,
    private readonly config: ApiConfig,
  ) {}

  async create(input: CreatePlaybackSession): Promise<StoredPlaybackSession> {
    const item = await this.requirePlayableMedia(input.mediaItemId);
    const variant = selectVariant(item, input.variantId);
    if (!variant) throw new AppError(404, 'NOT_FOUND', 'Requested quality is unavailable');
    const selectedItem = { ...item, compatibility: variant.compatibility };
    const now = Date.now();
    const base: StoredPlaybackSession = {
      id: randomUUID(),
      mediaItemId: item.id,
      variantId: variant.id,
      qualityLabel: variant.label,
      state: 'PREPARING',
      capabilities: input.clientCapabilities,
      expiresAt: new Date(now + this.config.playbackTtlSeconds * 1000).toISOString(),
    };

    if (!supportsHls(input.clientCapabilities)) {
      const unsupported: StoredPlaybackSession = {
        ...base,
        state: 'UNSUPPORTED_CLIENT',
        reasonCode: 'HLS_MSE_UNAVAILABLE',
      };
      await this.repository.createPlaybackSession(unsupported);
      return unsupported;
    }
    if (selectedItem.compatibility === 'HOLD_HDR') {
      const unsupported: StoredPlaybackSession = {
        ...base,
        state: 'UNSUPPORTED_CLIENT',
        reasonCode: 'HDR_UNSUPPORTED_V1',
      };
      await this.repository.createPlaybackSession(unsupported);
      return unsupported;
    }
    if (selectedItem.compatibility === 'INVALID') {
      const failed: StoredPlaybackSession = {
        ...base,
        state: 'FAILED',
        reasonCode: 'MEDIA_NOT_VALIDATED',
      };
      await this.repository.createPlaybackSession(failed);
      return failed;
    }

    await this.repository.createPlaybackSession(base);
    const preparation = await this.media.prepare({
      sessionId: base.id,
      mediaItem: selectedItem,
      variantId: variant.id,
      capabilities: input.clientCapabilities,
      protectUntil: base.expiresAt,
    });
    const session = this.mergePreparation(base, preparation);
    await this.repository.updatePlaybackSession(session);
    return session;
  }

  async get(id: string): Promise<StoredPlaybackSession> {
    const session = await this.repository.getPlaybackSession(id);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) {
      throw new AppError(404, 'NOT_FOUND', 'Playback session not found');
    }
    if (session.state !== 'PREPARING') return session;
    const item = await this.requirePlayableMedia(session.mediaItemId);
    const variant = selectVariant(item, session.variantId);
    if (!variant) throw new AppError(404, 'NOT_FOUND', 'Playback quality is no longer available');
    const preparation = await this.media.getStatus({
      sessionId: id,
      mediaItem: { ...item, compatibility: variant.compatibility },
      variantId: variant.id,
      protectUntil: session.expiresAt,
    });
    const updated = this.mergePreparation(session, preparation);
    await this.repository.updatePlaybackSession(updated);
    return updated;
  }

  toPublic(session: StoredPlaybackSession): PlaybackSession {
    const { capabilities: _capabilities, ...publicSession } = session;
    return publicSession;
  }

  private async requirePlayableMedia(id: string): Promise<MediaItemForPlayback> {
    const item = await this.repository.getMediaItem(id);
    if (!item || !item.published) {
      throw new AppError(404, 'NOT_FOUND', 'Media item not found');
    }
    return item;
  }

  private mergePreparation(
    session: StoredPlaybackSession,
    preparation: MediaPreparation,
  ): StoredPlaybackSession {
    if (preparation.state === 'READY' || (preparation.state === 'PREPARING' && preparation.playable)) {
      if (!preparation.generationId || !preparation.manifestPath) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Ready media preparation is incomplete');
      }
      const expectedPrefix = new RegExp(
        `^/media/(?:derived/)?generations/${preparation.generationId}/`,
      );
      if (!expectedPrefix.test(preparation.manifestPath)) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Media preparation returned an unsafe path');
      }
      return {
        ...session,
        state: 'READY',
        generationId: preparation.generationId,
        manifestUrl: publicMediaUrl(this.config.mediaPublicBaseUrl, preparation.manifestPath),
        durationSeconds: preparation.durationSeconds ?? 0,
        audioTracks: preparation.audioTracks ?? [],
        subtitleTracks: preparation.subtitleTracks ?? [],
      };
    }
    return {
      ...session,
      state: preparation.state,
      ...(preparation.pollAfterMs ? { pollAfterMs: preparation.pollAfterMs } : {}),
      ...(preparation.reasonCode ? { reasonCode: preparation.reasonCode } : {}),
    };
  }
}

function selectVariant(item: MediaItemForPlayback, requestedId?: string) {
  const available = item.variants.filter((variant) => variant.available);
  if (requestedId) return available.find((variant) => variant.id === requestedId);
  if (available.length === 0) {
    return item.published ? {
      id: item.id,
      label: 'Source',
      compatibility: item.compatibility,
      available: true,
      isDefault: true,
    } : undefined;
  }
  return available.find((variant) => variant.isDefault)
    ?? [...available].sort((left, right) => {
      const leftHeight = left.height ?? 0;
      const rightHeight = right.height ?? 0;
      const distance = Math.abs(leftHeight - 720) - Math.abs(rightHeight - 720);
      if (distance !== 0) return distance;
      return leftHeight <= 720 && rightHeight > 720 ? -1 : 1;
    })[0];
}

function supportsHls(capabilities: ClientCapabilities): boolean {
  return capabilities.nativeHls || (capabilities.mse && capabilities.hlsJs);
}

function publicMediaUrl(baseUrl: string, manifestPath: string): string {
  const base = new URL(baseUrl);
  const mediaBasePath = base.pathname.replace(/\/$/, '');
  if (!manifestPath.startsWith(`${mediaBasePath}/`) && mediaBasePath !== '/media') {
    throw new AppError(500, 'INTERNAL_ERROR', 'Manifest path does not match media base URL');
  }
  base.pathname = manifestPath;
  base.search = '';
  base.hash = '';
  return base.toString();
}
