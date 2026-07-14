import { normalizeStreamLanguage } from './language.js';
import type { Classification, MediaProbe, NormalizedTrack, ProbeStream } from './types.js';

function isHdr(stream: ProbeStream): boolean {
  const transfer = stream.color_transfer?.toLowerCase();
  const primaries = stream.color_primaries?.toLowerCase();
  if (transfer === 'smpte2084' || transfer === 'arib-std-b67' || primaries === 'bt2020') return true;
  return (stream.side_data_list ?? []).some((data) => {
    const encoded = JSON.stringify(data).toLowerCase();
    return encoded.includes('dolby vision') || encoded.includes('hdr10+') || encoded.includes('mastering display');
  });
}

function isCopySafeVideo(stream: ProbeStream): boolean {
  const depth = Number.parseInt(stream.bits_per_raw_sample ?? '8', 10);
  const profile = stream.profile?.toLowerCase() ?? '';
  return stream.codec_name === 'h264'
    && ['yuv420p', 'yuvj420p'].includes(stream.pix_fmt ?? '')
    && (Number.isNaN(depth) || depth <= 8)
    && !profile.includes('high 10')
    && !profile.includes('high 4:2')
    && (stream.field_order === undefined || ['progressive', 'unknown'].includes(stream.field_order));
}

function isCopySafeAudio(stream: ProbeStream): boolean {
  const profile = stream.profile?.toLowerCase();
  return stream.codec_name === 'aac'
    && (profile === undefined || profile === 'lc' || profile.includes('low complexity'))
    && (stream.channels ?? 2) <= 6;
}

export interface ClassificationOptions {
  maxCopySegmentDuration?: number;
  measuredMaxGopSeconds?: number;
}

export function classifyMedia(probe: MediaProbe, options: ClassificationOptions = {}): Classification {
  const videos = probe.streams.filter((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
  const audios = probe.streams.filter((stream) => stream.codec_type === 'audio');
  const reasons: string[] = [];
  const duration = Number.parseFloat(probe.format.duration ?? 'NaN');
  if (videos.length === 0) reasons.push('NO_VIDEO');
  if (audios.length === 0) reasons.push('NO_AUDIO');
  if (!Number.isFinite(duration) || duration <= 0) reasons.push('INVALID_DURATION');
  if ((probe.format.probe_score ?? 100) < 25) reasons.push('LOW_PROBE_SCORE');
  const video = videos[0];
  if (video === undefined || audios.length === 0 || reasons.length > 0) {
    return { class: 'INVALID', reasons, audioStreamIndexes: audios.map((stream) => stream.index) };
  }
  if (isHdr(video)) {
    return { class: 'HOLD_HDR', reasons: ['HDR_UNSUPPORTED_V1'], videoStreamIndex: video.index, audioStreamIndexes: audios.map((stream) => stream.index) };
  }
  if (!isCopySafeVideo(video)) {
    return {
      class: 'VIDEO_TRANSCODE',
      reasons: [`VIDEO_CODEC_UNSUPPORTED:${video.codec_name ?? 'unknown'}`, `VIDEO_PIXEL_FORMAT:${video.pix_fmt ?? 'unknown'}`],
      videoStreamIndex: video.index,
      audioStreamIndexes: audios.map((stream) => stream.index),
    };
  }
  const maxGop = options.measuredMaxGopSeconds;
  if (maxGop !== undefined && maxGop > (options.maxCopySegmentDuration ?? 18)) {
    return {
      class: 'VIDEO_TRANSCODE',
      reasons: [`GOP_TOO_LONG:${maxGop.toFixed(3)}`],
      videoStreamIndex: video.index,
      audioStreamIndexes: audios.map((stream) => stream.index),
    };
  }
  const unsupportedAudio = audios.filter((stream) => !isCopySafeAudio(stream));
  if (unsupportedAudio.length > 0) {
    return {
      class: 'AUDIO_TRANSCODE',
      reasons: unsupportedAudio.map((stream) => `AUDIO_CODEC_UNSUPPORTED:${stream.index}:${stream.codec_name ?? 'unknown'}`),
      videoStreamIndex: video.index,
      audioStreamIndexes: audios.map((stream) => stream.index),
    };
  }
  return {
    class: 'COPY',
    reasons: [],
    videoStreamIndex: video.index,
    audioStreamIndexes: audios.map((stream) => stream.index),
  };
}

export function normalizeTracks(probe: MediaProbe): NormalizedTrack[] {
  return probe.streams.flatMap((stream): NormalizedTrack[] => {
    if (!['video', 'audio', 'subtitle', 'attachment'].includes(stream.codec_type ?? '')) return [];
    const type = stream.codec_type as NormalizedTrack['type'];
    const language = normalizeStreamLanguage(stream);
    return [{
      index: stream.index,
      type,
      codec: stream.codec_name ?? 'unknown',
      language,
      ...(stream.tags?.title === undefined ? {} : { label: stream.tags.title }),
      default: type === 'subtitle' ? language === 'fa' : stream.disposition?.default === 1,
      // Embedded flags are advisory; full-track ASS marked forced is common in this archive.
      forced: false,
    }];
  });
}
