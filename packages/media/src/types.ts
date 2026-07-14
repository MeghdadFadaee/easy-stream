export type CompatibilityClass =
  | 'COPY'
  | 'AUDIO_TRANSCODE'
  | 'VIDEO_TRANSCODE'
  | 'HOLD_HDR'
  | 'INVALID';

export interface ProbeDisposition {
  default?: number;
  forced?: number;
  attached_pic?: number;
  [key: string]: number | undefined;
}

export interface ProbeStream {
  index: number;
  codec_name?: string;
  codec_long_name?: string;
  codec_type?: 'video' | 'audio' | 'subtitle' | 'attachment' | string;
  profile?: string;
  mime_codec_string?: string;
  bit_rate?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  level?: number;
  field_order?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  bits_per_raw_sample?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_space?: string;
  duration?: string;
  extradata_size?: number;
  disposition?: ProbeDisposition;
  tags?: Record<string, string | undefined>;
  side_data_list?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface ProbeFormat {
  filename?: string;
  format_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
  probe_score?: number;
  tags?: Record<string, string | undefined>;
  [key: string]: unknown;
}

export interface MediaProbe {
  streams: ProbeStream[];
  format: ProbeFormat;
  chapters: Array<Record<string, unknown>>;
}

export interface SourceFingerprint {
  version: 1;
  algorithm: 'sha256';
  relativePath: string;
  size: string;
  mtimeNs: string;
  edgeBytes: number;
  digest: string;
}

export interface NormalizedTrack {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'attachment';
  codec: string;
  language: string;
  label?: string;
  default: boolean;
  forced: boolean;
}

export interface Classification {
  class: CompatibilityClass;
  reasons: string[];
  videoStreamIndex?: number;
  audioStreamIndexes: number[];
}

export interface ExtractedSubtitle {
  streamIndex: number;
  language: string;
  assPath: string;
  vttPath: string;
  cueCount: number;
  default: boolean;
  forced: boolean;
}

export interface StoredFont {
  streamIndex: number;
  sha256: string;
  path: string;
  originalName: string;
  size: number;
  format: 'ttf' | 'otf';
}

export interface HlsPlaylistValidation {
  path: string;
  segmentCount: number;
  targetDuration: number;
  minDuration: number;
  maxDuration: number;
  totalDuration: number;
  ended: boolean;
}

export interface PackageResult {
  generation: string;
  outputDirectory: string;
  masterPlaylist: string;
  videoPlaylist: HlsPlaylistValidation;
  audioPlaylists: HlsPlaylistValidation[];
  knownAacRepairs: number;
}
