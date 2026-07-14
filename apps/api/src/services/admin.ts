import { randomUUID } from 'node:crypto';
import { argon2id, hash, verify } from 'argon2';
import type {
  AdminLogin,
  AdminSessionResponse,
  Job,
  MetadataMatchBody,
  MetadataSearchQuery,
} from '@easy-stream/contracts';
import type { ApiConfig } from '../config.js';
import { randomToken, sha256 } from '../crypto.js';
import type {
  AdminRecord,
  AppRepository,
  MediaCommandPublisher,
  MediaPreparationService,
  MetadataProvider,
  PasswordHasher,
  TotpVerifier,
} from '../domain.js';
import { AppError } from '../errors.js';

export class Argon2PasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return hash(password, {
      type: argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }
}

export class DenyEncryptedTotpVerifier implements TotpVerifier {
  async verify(): Promise<boolean> {
    return false;
  }
}

interface AdminPrincipal {
  admin: AdminRecord;
  sessionId: string;
}

export class AdminService {
  private dummyPasswordHash?: string;

  constructor(
    private readonly repository: AppRepository,
    private readonly commands: MediaCommandPublisher,
    private readonly media: MediaPreparationService,
    private readonly metadata: MetadataProvider,
    private readonly passwordHasher: PasswordHasher,
    private readonly totpVerifier: TotpVerifier,
    private readonly config: ApiConfig,
  ) {}

  async initialize(): Promise<void> {
    this.dummyPasswordHash = await this.passwordHasher.hash(randomToken());
    if (!this.config.adminBootstrapEmail || !this.config.adminBootstrapPassword) return;
    const existing = await this.repository.findAdminByEmail(this.config.adminBootstrapEmail);
    if (existing) return;
    await this.repository.createAdmin({
      id: randomUUID(),
      email: this.config.adminBootstrapEmail,
      passwordHash: await this.passwordHasher.hash(this.config.adminBootstrapPassword),
      disabled: false,
    });
  }

  async login(input: AdminLogin): Promise<{
    response: AdminSessionResponse;
    rawToken: string;
  }> {
    const admin = await this.repository.findAdminByEmail(input.email);
    const validPassword = await this.passwordHasher.verify(
      admin?.passwordHash ?? this.dummyPasswordHash ?? '$argon2id$invalid',
      input.password,
    );
    if (!admin || !validPassword || admin.disabled) throw invalidCredentials();
    if (
      admin.totpSecretEncrypted &&
      (!input.totp || !(await this.totpVerifier.verify(admin.totpSecretEncrypted, input.totp)))
    ) {
      throw invalidCredentials();
    }

    const rawToken = randomToken();
    const csrfToken = randomToken();
    const expiresAt = new Date(
      Date.now() + this.config.adminSessionTtlSeconds * 1000,
    ).toISOString();
    await this.repository.createAdminSession({
      id: randomUUID(),
      adminId: admin.id,
      tokenHash: sha256(rawToken),
      csrfTokenHash: sha256(csrfToken),
      expiresAt,
    });
    return {
      rawToken,
      response: {
        admin: { id: admin.id, email: admin.email },
        csrfToken,
        expiresAt,
      },
    };
  }

  async authenticate(rawToken: string | undefined, csrfToken?: string): Promise<AdminPrincipal> {
    if (!rawToken) throw new AppError(401, 'UNAUTHORIZED', 'Administrator authentication required');
    const session = await this.repository.findAdminSessionByTokenHash(sha256(rawToken));
    if (
      !session ||
      session.revokedAt ||
      Date.parse(session.expiresAt) <= Date.now() ||
      (csrfToken !== undefined && sha256(csrfToken) !== session.csrfTokenHash)
    ) {
      throw new AppError(401, 'UNAUTHORIZED', 'Administrator session is invalid or expired');
    }
    const admin = await this.repository.findAdminById(session.adminId);
    if (!admin || admin.disabled) {
      throw new AppError(401, 'UNAUTHORIZED', 'Administrator session is invalid or expired');
    }
    return { admin, sessionId: session.id };
  }

  async logout(rawToken: string | undefined, csrfToken: string | undefined): Promise<void> {
    const principal = await this.authenticate(rawToken, csrfToken);
    await this.repository.revokeAdminSession(principal.sessionId);
  }

  async startScan(full: boolean): Promise<Job> {
    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(),
      type: 'ARCHIVE_SCAN',
      state: 'QUEUED',
      progress: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.createJob(job, { full });
    await this.commands.publish({ type: 'archive.scan.requested', jobId: job.id, full });
    return job;
  }

  async setPublished(mediaItemId: string, published: boolean): Promise<void> {
    const item = await this.repository.getMediaItem(mediaItemId);
    if (!item) throw new AppError(404, 'NOT_FOUND', 'Media item not found');
    if (published && (item.compatibility === 'INVALID' || item.compatibility === 'HOLD_HDR')) {
      throw new AppError(409, 'CONFLICT', 'This media item is not eligible for publication');
    }
    if (
      published &&
      (item.compatibility === 'AUDIO_TRANSCODE' || item.compatibility === 'VIDEO_TRANSCODE')
    ) {
      const preparation = await this.media.getStatus({
        sessionId: randomUUID(),
        mediaItem: item,
        variantId: item.variants.find((variant) => variant.available && variant.isDefault)?.id
          ?? item.variants.find((variant) => variant.available)?.id
          ?? item.id,
      });
      if (preparation.state !== 'READY' && !preparation.playable) {
        throw new AppError(
          409,
          'CONFLICT',
          'The browser-compatible representation must be ready before publication',
        );
      }
    }
    if (!(await this.repository.setMediaPublished(mediaItemId, published))) {
      throw new AppError(404, 'NOT_FOUND', 'Media item not found');
    }
    await this.commands.publish({
      type: 'media.publication.changed',
      mediaItemId,
      published,
    });
  }

  async retryJob(jobId: string): Promise<Job> {
    const existing = await this.repository.findJob(jobId);
    if (existing !== undefined && existing.type !== 'ARCHIVE_SCAN') {
      throw new AppError(409, 'CONFLICT', `Retry is not implemented for job type ${existing.type}`);
    }
    const job = await this.repository.retryJob(jobId);
    if (!job) throw new AppError(409, 'CONFLICT', 'Only failed or cancelled jobs can be retried');
    // A full scan is the conservative retry when the public Job contract does not expose
    // the original private payload.
    await this.commands.publish({ type: 'archive.scan.requested', jobId: job.id, full: true });
    return job;
  }

  async evict(generationId: string): Promise<void> {
    await this.commands.publish({ type: 'package.eviction.requested', generationId });
  }

  async searchMetadata(query: MetadataSearchQuery) {
    return this.metadata.search({
      query: query.q,
      kind: query.kind,
      ...(query.year !== undefined ? { year: query.year } : {}),
    });
  }

  async matchMetadata(titleId: string, body: MetadataMatchBody) {
    const candidate = await this.metadata.getDetails({
      externalId: body.externalId,
      kind: body.kind,
    });
    if (!(await this.repository.applyTitleMetadata(titleId, candidate))) {
      throw new AppError(404, 'NOT_FOUND', 'Title not found or title kind does not match');
    }
    return candidate;
  }
}

function invalidCredentials(): AppError {
  return new AppError(401, 'UNAUTHORIZED', 'Invalid email, password, or verification code');
}
