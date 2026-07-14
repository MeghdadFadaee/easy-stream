import { describe, expect, it } from 'vitest';
import { classifyMedia, detectTextLanguage, normalizeLanguage } from '../src/index.js';
import { audio, probe, video } from './fixtures.js';

describe('media compatibility', () => {
  it('copy-packages browser-safe H.264 and AAC-LC', () => {
    expect(classifyMedia(probe())).toMatchObject({ class: 'COPY', videoStreamIndex: 0, audioStreamIndexes: [1] });
  });

  it('selects audio-only transcoding for DTS', () => {
    expect(classifyMedia(probe([video(), audio({ codec_name: 'dts', profile: undefined })])).class)
      .toBe('AUDIO_TRANSCODE');
  });

  it('selects video transcoding for HEVC SDR', () => {
    expect(classifyMedia(probe([video({ codec_name: 'hevc', pix_fmt: 'yuv420p10le' }), audio()])).class)
      .toBe('VIDEO_TRANSCODE');
  });

  it('holds HDR independently of codec', () => {
    expect(classifyMedia(probe([video({ color_transfer: 'smpte2084', color_primaries: 'bt2020' }), audio()]))).toMatchObject({
      class: 'HOLD_HDR', reasons: ['HDR_UNSUPPORTED_V1'],
    });
  });

  it('rejects media without an audio stream', () => {
    expect(classifyMedia(probe([video()]))).toMatchObject({ class: 'INVALID', reasons: ['NO_AUDIO'] });
  });
});

describe('language normalization', () => {
  it('maps ISO-639 aliases', () => {
    expect(normalizeLanguage('per')).toBe('fa');
    expect(normalizeLanguage('jpn')).toBe('ja');
  });

  it('uses script evidence for private or wrong tags', () => {
    const english = 'This is enough English dialogue text for reliable script detection.';
    expect(normalizeLanguage('qad', english)).toBe('en');
    expect(normalizeLanguage('eng', 'این یک زیرنویس فارسی برای تشخیص زبان است')).toBe('fa');
    expect(detectTextLanguage('این یک زیرنویس فارسی برای تشخیص زبان است')).toBe('fa');
    expect(detectTextLanguage('هذا نص عربي واضح لاختبار اكتشاف لغة الترجمة العربية')).toBe('ar');
  });
});
