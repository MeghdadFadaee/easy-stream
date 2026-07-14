import { describe, expect, it } from 'vitest';
import { mediaProcessEnvironment } from '../src/index.js';

describe('media child process environment', () => {
  it('keeps runtime paths but strips application secrets', () => {
    expect(mediaProcessEnvironment({
      PATH: '/usr/bin',
      LD_LIBRARY_PATH: '/opt/ffmpeg/lib',
      DATABASE_URL: 'postgres://secret',
      REDIS_URL: 'redis://secret',
      PLAYBACK_SIGNING_SECRET: 'secret',
    })).toEqual({
      PATH: '/usr/bin',
      LD_LIBRARY_PATH: '/opt/ffmpeg/lib',
    });
  });
});
