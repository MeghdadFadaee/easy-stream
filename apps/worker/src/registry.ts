import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PackageRegistrySchema } from '@easy-stream/contracts';
import { Value } from '@sinclair/typebox/value';

const MAX_TRACK_LABEL_LENGTH = 100;
const UNSAFE_LABEL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/** Converts untrusted container metadata into a bounded, single-line UI label. */
export function normalizeTrackLabel(value: string | undefined, fallback: string): string {
  const clean = (candidate: string | undefined): string => (candidate ?? '')
    .normalize('NFKC')
    .replace(UNSAFE_LABEL_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const label = clean(value) || clean(fallback) || 'und';
  if (label.length <= MAX_TRACK_LABEL_LENGTH) return label;

  // JSON Schema maxLength is enforced at this boundary. Avoid leaving a lone
  // high surrogate when the UTF-16 limit cuts through an astral character.
  let end = MAX_TRACK_LABEL_LENGTH;
  const finalCodeUnit = label.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1;
  return label.slice(0, end).trimEnd();
}

export interface RegistryAudioTrack {
  id: string;
  language: string;
  label: string;
  default: boolean;
}

export interface RegistrySubtitleTrack {
  id: string;
  language: string;
  label: string;
  default: boolean;
  forced: boolean;
  assUrl?: string;
  vttUrl?: string;
  fontUrls: string[];
}

export interface RegistryGeneration {
  mediaItemId: string;
  variantId?: string;
  state: 'PREPARING' | 'READY' | 'UNSUPPORTED_CLIENT' | 'FAILED';
  generationId?: string;
  manifestPath?: string;
  /** True once a progressive EVENT manifest has enough validated media. */
  playable: boolean;
  reasonCode?: string;
  pollAfterMs?: number;
  durationSeconds?: number;
  audioTracks?: RegistryAudioTrack[];
  subtitleTracks?: RegistrySubtitleTrack[];
}

export interface PackageRegistry {
  version: 1;
  updatedAt: string;
  packages: RegistryGeneration[];
}

const writes = new Map<string, Promise<void>>();

export async function readRegistry(registryPath: string): Promise<PackageRegistry> {
  try {
    const value: unknown = JSON.parse(await readFile(registryPath, 'utf8'));
    assertValidRegistry(value, `Invalid package registry at ${registryPath}`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { version: 1, updatedAt: new Date(0).toISOString(), packages: [] };
  }
}

export async function writeRegistry(registryPath: string, registry: PackageRegistry): Promise<void> {
  assertValidRegistry(registry, `Refusing to publish invalid package registry at ${registryPath}`);
  const destination = path.resolve(registryPath);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o750 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o640 });
  await rename(temporary, destination);
}

function assertValidRegistry(value: unknown, message: string): asserts value is PackageRegistry {
  if (Value.Check(PackageRegistrySchema, value)) return;
  const detail = [...Value.Errors(PackageRegistrySchema, value)]
    .slice(0, 8)
    .map((error) => `${error.path || '/'} ${error.message}`)
    .join('; ');
  throw new Error(`${message}: ${detail}`);
}

export async function updateRegistry(
  registryPath: string,
  mediaItemId: string,
  generation: RegistryGeneration,
): Promise<void> {
  const key = path.resolve(registryPath);
  const previous = writes.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const registry = await readRegistry(key);
    registry.updatedAt = new Date().toISOString();
    const index = registry.packages.findIndex((entry) => entry.mediaItemId === mediaItemId
      && (entry.variantId ?? entry.mediaItemId) === (generation.variantId ?? generation.mediaItemId));
    if (index < 0) registry.packages.push(generation);
    else {
      const current = registry.packages[index];
      // An idempotent package verification must never make an already served generation
      // disappear or regress to PREPARING/FAILED.
      if (current !== undefined && current.generationId === generation.generationId
        && current.state === 'READY' && generation.state !== 'READY') return;
      registry.packages[index] = generation;
    }
    await writeRegistry(key, registry);
  });
  writes.set(key, current);
  try {
    await current;
  } finally {
    if (writes.get(key) === current) writes.delete(key);
  }
}

export async function removeGenerationFromRegistry(registryPath: string, generationId: string): Promise<boolean> {
  return (await removeGenerationsFromRegistry(registryPath, new Set([generationId]))).length > 0;
}

export async function removeGenerationsFromRegistry(
  registryPath: string,
  generationIds: ReadonlySet<string>,
): Promise<string[]> {
  const key = path.resolve(registryPath);
  const previous = writes.get(key) ?? Promise.resolve();
  let removed: string[] = [];
  const current = previous.catch(() => undefined).then(async () => {
    const registry = await readRegistry(key);
    removed = registry.packages
      .flatMap((entry) => entry.generationId && generationIds.has(entry.generationId) ? [entry.generationId] : []);
    if (removed.length === 0) return;
    const packages = registry.packages.filter((entry) => entry.generationId === undefined || !generationIds.has(entry.generationId));
    registry.packages = packages;
    registry.updatedAt = new Date().toISOString();
    await writeRegistry(key, registry);
  });
  writes.set(key, current);
  try {
    await current;
    return removed;
  } finally {
    if (writes.get(key) === current) writes.delete(key);
  }
}
