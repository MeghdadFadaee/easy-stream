import { describe, expect, it } from 'vitest';
import { deterministicUuid, parseMediaIdentity, shouldInspectSubtitleContent, slugify } from '../src/catalog.js';

describe('catalog filename parsing', () => {
  it('groups the supplied season folder and episode filename', () => {
    expect(parseMediaIdentity('Mushoku Tensei S3/Mushoku Tensei S3 - 01.[SS][720p][MixFlixTop].mkv'))
      .toEqual({ kind: 'SERIES', title: 'Mushoku Tensei', seasonNumber: 3, episodeNumber: 1, episodeTitle: 'Episode 1' });
  });

  it('creates stable UUIDs and Unicode-safe slugs', () => {
    expect(deterministicUuid('same')).toBe(deterministicUuid('same'));
    expect(deterministicUuid('same')).toMatch(/^[0-9a-f-]{36}$/u);
    expect(slugify('فیلم نمونه')).toBe('فیلم-نمونه');
  });

  it('samples only unknown textual subtitle languages during archive scans', () => {
    expect(shouldInspectSubtitleContent({ index: 2, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'qad' } })).toBe(true);
    expect(shouldInspectSubtitleContent({ index: 3, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'und' } })).toBe(true);
    expect(shouldInspectSubtitleContent({ index: 4, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'per' } })).toBe(false);
    expect(shouldInspectSubtitleContent({ index: 5, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } })).toBe(false);
    expect(shouldInspectSubtitleContent({ index: 6, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' })).toBe(false);
  });
});
