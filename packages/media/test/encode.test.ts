import { describe, expect, it } from 'vitest';
import { buildCompatibilityEncodeArguments, classifyMedia } from '../src/index.js';
import { audio, probe, video } from './fixtures.js';

describe('offline compatibility encode profile', () => {
  it('builds same-resolution H.264 CRF18 CMAF with bounded closed GOP and channel-aware AAC', () => {
    const media = probe([
      video({ codec_name: 'hevc', pix_fmt: 'yuv420p10le', avg_frame_rate: '24000/1001' }),
      audio({ index: 1, codec_name: 'dts', channels: 2 }),
      audio({ index: 2, codec_name: 'truehd', channels: 6, tags: { language: 'eng' } }),
    ]);
    const classification = classifyMedia(media);
    const args = buildCompatibilityEncodeArguments('/archive/source.mkv', '/derived/build', media, classification);
    expect(args).toContain('libx264');
    expect(args.slice(args.indexOf('-crf'), args.indexOf('-crf') + 2)).toEqual(['-crf', '18']);
    expect(args.slice(args.indexOf('-pix_fmt'), args.indexOf('-pix_fmt') + 2)).toEqual(['-pix_fmt', 'yuv420p']);
    expect(args.slice(args.indexOf('-g'), args.indexOf('-g') + 2)).toEqual(['-g', '144']);
    expect(args).toContain('expr:gte(t,n_forced*6)');
    expect(args.slice(args.indexOf('-b:a:0'), args.indexOf('-b:a:0') + 2)).toEqual(['-b:a:0', '192k']);
    expect(args.slice(args.indexOf('-b:a:1'), args.indexOf('-b:a:1') + 2)).toEqual(['-b:a:1', '384k']);
    expect(args).toContain('vod');
    expect(args).toContain('fmp4');
  });

  it('hard-refuses HDR input', () => {
    const media = probe([video({ codec_name: 'hevc', color_transfer: 'smpte2084' }), audio()]);
    expect(() => buildCompatibilityEncodeArguments('/a', '/b', media, classifyMedia(media))).toThrow('HDR_UNSUPPORTED_V1');
  });
});
