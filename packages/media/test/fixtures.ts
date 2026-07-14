import type { MediaProbe, ProbeStream } from '../src/index.js';

export function video(overrides: Partial<ProbeStream> = {}): ProbeStream {
  return {
    index: 0,
    codec_type: 'video',
    codec_name: 'h264',
    profile: 'High',
    mime_codec_string: 'avc1.64001f',
    width: 1280,
    height: 720,
    pix_fmt: 'yuv420p',
    bits_per_raw_sample: '8',
    field_order: 'progressive',
    tags: { BPS: '652016' },
    ...overrides,
  };
}

export function audio(overrides: Partial<ProbeStream> = {}): ProbeStream {
  return {
    index: 1,
    codec_type: 'audio',
    codec_name: 'aac',
    profile: 'LC',
    channels: 2,
    sample_rate: '48000',
    tags: { language: 'jpn', BPS: '200416' },
    ...overrides,
  };
}

export function probe(streams: ProbeStream[] = [video(), audio()]): MediaProbe {
  return {
    streams,
    format: {
      format_name: 'matroska,webm',
      duration: '1420.095',
      bit_rate: '899640',
      probe_score: 100,
    },
    chapters: [],
  };
}
