import { readFile, stat, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { HlsPlaylistValidation, MediaProbe, ProbeStream } from './types.js';

const URI_PATTERN = /^(?![a-z][a-z0-9+.-]*:)(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/iu;

export interface ParsedMediaPlaylist {
  targetDuration: number;
  playlistType?: string;
  mapUri?: string;
  segments: Array<{ duration: number; uri: string }>;
  ended: boolean;
}

function attribute(line: string, name: string): string | undefined {
  const match = line.match(new RegExp(`(?:^|,)${name}=(?:"([^"]*)"|([^,]*))`, 'u'));
  return match?.[1] ?? match?.[2];
}

export function parseMediaPlaylist(content: string): ParsedMediaPlaylist {
  const lines = content.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('Playlist is missing EXTM3U');
  let targetDuration = 0;
  let playlistType: string | undefined;
  let mapUri: string | undefined;
  let pendingDuration: number | undefined;
  const segments: ParsedMediaPlaylist['segments'] = [];
  let ended = false;
  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = Number(line.slice(22));
    else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) playlistType = line.slice(21);
    else if (line.startsWith('#EXT-X-MAP:')) mapUri = attribute(line.slice(11), 'URI');
    else if (line.startsWith('#EXTINF:')) pendingDuration = Number(line.slice(8).split(',')[0]);
    else if (line === '#EXT-X-ENDLIST') ended = true;
    else if (!line.startsWith('#')) {
      if (pendingDuration === undefined || !Number.isFinite(pendingDuration) || pendingDuration <= 0) {
        throw new Error(`Segment URI has no valid EXTINF: ${line}`);
      }
      segments.push({ duration: pendingDuration, uri: line });
      pendingDuration = undefined;
    }
  }
  if (!Number.isInteger(targetDuration) || targetDuration < 1) throw new Error('Invalid HLS target duration');
  if (mapUri === undefined) throw new Error('Fragmented MP4 playlist has no EXT-X-MAP');
  return { targetDuration, ...(playlistType === undefined ? {} : { playlistType }), mapUri, segments, ended };
}

function assertSafeUri(uri: string): void {
  if (!URI_PATTERN.test(uri)) throw new Error(`Unsafe or external HLS URI: ${uri}`);
}

export async function validateMediaPlaylist(
  playlistPath: string,
  options: { requireEnded?: boolean; maxTargetDuration?: number; minSegments?: number } = {},
): Promise<HlsPlaylistValidation> {
  const content = await readFile(playlistPath, 'utf8');
  const parsed = parseMediaPlaylist(content);
  if (options.requireEnded === true && !parsed.ended) throw new Error(`${playlistPath} has no ENDLIST`);
  if (parsed.targetDuration > (options.maxTargetDuration ?? 18)) {
    throw new Error(`${playlistPath} target duration ${parsed.targetDuration} exceeds the compatibility limit`);
  }
  if (parsed.segments.length < (options.minSegments ?? 1)) throw new Error(`${playlistPath} has too few segments`);
  const directory = path.dirname(playlistPath);
  const mapUri = parsed.mapUri;
  if (mapUri === undefined) throw new Error('Fragmented MP4 playlist has no EXT-X-MAP');
  const referenced = [mapUri, ...parsed.segments.map((segment) => segment.uri)];
  for (const uri of referenced) {
    assertSafeUri(uri);
    const file = path.resolve(directory, uri);
    if (!file.startsWith(`${path.resolve(directory)}${path.sep}`)) throw new Error(`HLS URI escapes playlist directory: ${uri}`);
    const details = await stat(file);
    if (!details.isFile() || details.size === 0) throw new Error(`HLS resource is missing or empty: ${uri}`);
  }
  const durations = parsed.segments.map((segment) => segment.duration);
  return {
    path: playlistPath,
    segmentCount: durations.length,
    targetDuration: parsed.targetDuration,
    minDuration: Math.min(...durations),
    maxDuration: Math.max(...durations),
    totalDuration: durations.reduce((sum, duration) => sum + duration, 0),
    ended: parsed.ended,
  };
}

export async function finalizeEventPlaylist(playlistPath: string): Promise<void> {
  const content = await readFile(playlistPath, 'utf8');
  const parsed = parseMediaPlaylist(content);
  if (!parsed.ended) throw new Error('Cannot finalize an incomplete EVENT playlist');
  const vod = content.replace('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-PLAYLIST-TYPE:VOD');
  const temporary = `${playlistPath}.vod.tmp`;
  await writeFile(temporary, vod, { encoding: 'utf8', mode: 0o640 });
  await rename(temporary, playlistPath);
}

function escapeAttribute(value: string): string {
  return value.replace(/["\r\n]/gu, '');
}

function streamBitrate(stream: ProbeStream, fallback: number): number {
  const raw = stream.bit_rate ?? stream.tags?.BPS ?? stream.tags?.bps;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface MasterAudio {
  streamIndex: number;
  language: string;
  name: string;
  uri: string;
  channels?: number;
  default: boolean;
}

export function buildMasterPlaylist(
  probe: MediaProbe,
  videoStreamIndex: number,
  videoUri: string,
  audio: readonly MasterAudio[],
): string {
  const video = probe.streams.find((stream) => stream.index === videoStreamIndex);
  if (video === undefined) throw new Error('Video stream is missing from probe');
  if (audio.length === 0) throw new Error('At least one audio rendition is required');
  const audioStreams = audio.map((item) => probe.streams.find((stream) => stream.index === item.streamIndex));
  const audioBandwidth = Math.max(...audioStreams.map((stream) => stream === undefined ? 384_000 : streamBitrate(stream, 384_000)));
  const containerBitrate = Number(probe.format.bit_rate);
  const conservativeVideoFallback = Number.isFinite(containerBitrate) && containerBitrate > audioBandwidth
    ? containerBitrate - audioBandwidth
    : 8_000_000;
  const videoBandwidth = streamBitrate(video, conservativeVideoFallback);
  const bandwidth = Math.ceil((videoBandwidth + audioBandwidth) * 1.15);
  const average = videoBandwidth + audioBandwidth;
  const codecs = [video.mime_codec_string ?? 'avc1.640028', 'mp4a.40.2'].join(',');
  const resolution = video.width !== undefined && video.height !== undefined ? `,RESOLUTION=${video.width}x${video.height}` : '';
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const item of audio) {
    assertSafeUri(item.uri);
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${escapeAttribute(item.name)}",LANGUAGE="${escapeAttribute(item.language)}",AUTOSELECT=YES,DEFAULT=${item.default ? 'YES' : 'NO'}${item.channels === undefined ? '' : `,CHANNELS="${item.channels}"`},URI="${item.uri}"`,
    );
  }
  assertSafeUri(videoUri);
  lines.push(
    `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${average}${resolution},CODECS="${escapeAttribute(codecs)}",AUDIO="audio"`,
    videoUri,
    '',
  );
  return lines.join('\n');
}

export interface WarningAssessment {
  knownAacRepairs: number;
  ignoredProbeWarnings: number;
  unknown: string[];
}

/** Only the observed one-sample AAC rounding repair is accepted. */
export function assessFfmpegWarnings(stderr: string): WarningAssessment {
  const lines = stderr.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  let knownAacRepairs = 0;
  let ignoredProbeWarnings = 0;
  const unknown: string[] = [];
  for (const line of lines) {
    const packet = line.match(/Packet duration:\s*(-?\d+)\s*\/\s*dts:/u);
    if (packet !== null) {
      if (Number(packet[1]) === -32) knownAacRepairs += 1;
      else unknown.push(line);
      continue;
    }
    if (line.includes('Could not find codec parameters for stream') && line.includes('Attachment: none')) {
      ignoredProbeWarnings += 1;
      continue;
    }
    if (line.startsWith('Consider increasing the value for the \'analyzeduration\'')) {
      ignoredProbeWarnings += 1;
      continue;
    }
    if (line === 'Bandwidth info not available, set audio and video bitrates') {
      ignoredProbeWarnings += 1;
      continue;
    }
    unknown.push(line);
  }
  return { knownAacRepairs, ignoredProbeWarnings, unknown };
}
