import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface PlaybackGrant {
  version: 1;
  sessionId: string;
  generationId: string;
  path: string;
  expiresAtEpochSeconds: number;
}

export class PlaybackGrantSigner {
  constructor(private readonly secret: string) {}

  sign(grant: PlaybackGrant): string {
    const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  verify(token: string): PlaybackGrant | undefined {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return undefined;
    const expected = createHmac('sha256', this.secret).update(payload).digest('base64url');
    if (!safeEqual(signature, expected)) return undefined;
    try {
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PlaybackGrant;
      if (
        value.version !== 1 ||
        !value.sessionId ||
        !value.generationId ||
        !value.path.startsWith('/media/') ||
        !Number.isInteger(value.expiresAtEpochSeconds)
      ) {
        return undefined;
      }
      return value;
    } catch {
      return undefined;
    }
  }
}

export function playbackCookieName(generationId: string): string {
  return `es_playback_${generationId.replaceAll('-', '')}`;
}
