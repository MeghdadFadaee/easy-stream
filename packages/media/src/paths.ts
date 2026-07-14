import { lstat, mkdir, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

function withSeparator(value: string): string {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

export function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(withSeparator(normalizedRoot));
}

export async function resolveInside(root: string, candidate: string): Promise<string> {
  const realRoot = await realpath(root);
  const realCandidate = await realpath(candidate);
  if (!isPathInside(realRoot, realCandidate)) {
    throw new UnsafePathError(`Path escapes configured root: ${candidate}`);
  }
  return realCandidate;
}

export async function assertWritableDestination(root: string, candidate: string): Promise<string> {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate === resolvedRoot || !isPathInside(resolvedRoot, resolvedCandidate)) {
    throw new UnsafePathError(`Output must be a child of its configured root: ${candidate}`);
  }
  await assertWritableRoot(resolvedRoot);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolvedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolvedCandidate;
    throw error;
  }
  let current = canonicalRoot;
  for (const component of path.relative(resolvedRoot, resolvedCandidate).split(path.sep)) {
    current = path.join(current, component);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) throw new UnsafePathError(`Symlink found in writable path: ${current}`);
      if (!details.isDirectory()) throw new UnsafePathError(`Writable path component is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return resolvedCandidate;
}

/** Rejects a configured writable root that is itself a symlink. Missing roots are allowed. */
export async function assertWritableRoot(root: string): Promise<string> {
  const resolvedRoot = path.resolve(root);
  try {
    const details = await lstat(resolvedRoot);
    if (details.isSymbolicLink()) throw new UnsafePathError(`Configured writable root is a symlink: ${resolvedRoot}`);
    if (!details.isDirectory()) throw new UnsafePathError(`Configured writable root is not a directory: ${resolvedRoot}`);
    await realpath(resolvedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return resolvedRoot;
}

/** Creates a managed child directory one component at a time without following planted symlinks. */
export async function ensureWritableDirectory(
  root: string,
  candidate: string,
  mode = 0o750,
): Promise<string> {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate === resolvedRoot || !isPathInside(resolvedRoot, resolvedCandidate)) {
    throw new UnsafePathError(`Output must be a child of its configured root: ${candidate}`);
  }
  await assertWritableRoot(resolvedRoot);
  try {
    await lstat(resolvedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(resolvedRoot, { recursive: true, mode });
    await assertWritableRoot(resolvedRoot);
  }
  const canonicalRoot = await realpath(resolvedRoot);
  let current = canonicalRoot;
  for (const component of path.relative(resolvedRoot, resolvedCandidate).split(path.sep)) {
    current = path.join(current, component);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink()) throw new UnsafePathError(`Symlink found in writable path: ${current}`);
      if (!details.isDirectory()) throw new UnsafePathError(`Writable path component is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await mkdir(current, { mode });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      const details = await lstat(current);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new UnsafePathError(`Refusing unsafe writable directory: ${current}`);
      }
    }
  }
  // Re-check the complete chain after creation so callers never receive a path whose
  // ancestor was replaced with a symlink while the components were being created.
  await assertWritableDestination(resolvedRoot, resolvedCandidate);
  return resolvedCandidate;
}

export interface WalkArchiveOptions {
  extensions?: readonly string[];
  maxDepth?: number;
}

/** Walks regular files only and never follows archive symlinks. */
export async function* walkArchive(
  archiveRoot: string,
  options: WalkArchiveOptions = {},
): AsyncGenerator<string> {
  const root = await realpath(archiveRoot);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new UnsafePathError(`Archive root is not a directory: ${root}`);
  const allowed = new Set((options.extensions ?? ['.mkv']).map((extension) => extension.toLowerCase()));
  const maxDepth = options.maxDepth ?? 32;

  async function* visit(directory: string, depth: number): AsyncGenerator<string> {
    if (depth > maxDepth) throw new UnsafePathError(`Archive tree exceeds maximum depth ${maxDepth}`);
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        yield* visit(candidate, depth + 1);
      } else if (entry.isFile() && allowed.has(path.extname(entry.name).toLowerCase())) {
        const verified = await resolveInside(root, candidate);
        yield verified;
      }
    }
  }

  yield* visit(root, 0);
}
