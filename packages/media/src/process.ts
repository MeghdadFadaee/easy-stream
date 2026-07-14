import { spawn } from 'node:child_process';

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunProcessOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export class ProcessFailure extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly result?: ProcessResult,
  ) {
    super(message);
    this.name = 'ProcessFailure';
  }
}

const MEDIA_PROCESS_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LD_LIBRARY_PATH',
  'DYLD_LIBRARY_PATH',
  'FONTCONFIG_FILE',
  'FONTCONFIG_PATH',
  'XDG_CACHE_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // Required for child-process startup on Windows development hosts.
  'SystemRoot',
  'WINDIR',
  'PATHEXT',
  'COMSPEC',
] as const;

/** Prevents FFmpeg/ffprobe from inheriting database, Redis, or application secrets. */
export function mediaProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of MEDIA_PROCESS_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

/** Runs a binary directly. Arguments never pass through a shell. */
export async function runProcess(
  binary: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  const maxOutput = options.maxOutputBytes ?? 16 * 1024 * 1024;
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(binary, [...args], {
      cwd: options.cwd,
      env: options.env ?? mediaProcessEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    const append = (current: string, currentBytes: number, chunk: Buffer): [string, number] => {
      if (currentBytes + chunk.length > maxOutput) {
        overflow = true;
        child.kill('SIGKILL');
        return [current, currentBytes];
      }
      return [`${current}${chunk.toString('utf8')}`, currentBytes + chunk.length];
    };

    child.stdout.on('data', (chunk: Buffer) => {
      [stdout, stdoutBytes] = append(stdout, stdoutBytes, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      [stderr, stderrBytes] = append(stderr, stderrBytes, chunk);
    });
    child.once('error', (error) => reject(error));

    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
    timer?.unref();

    child.once('close', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      const result: ProcessResult = {
        code: code ?? -1,
        stdout,
        stderr,
      };
      if (overflow) {
        reject(new ProcessFailure(`Process output exceeded ${maxOutput} bytes`, binary, result));
      } else if (code !== 0) {
        reject(new ProcessFailure(`${binary} exited with ${String(code)} (${signal ?? 'no signal'})`, binary, result));
      } else {
        resolve(result);
      }
    });
  });
}
