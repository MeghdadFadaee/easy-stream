import { describe, expect, it } from 'vitest';
import { subtitleAssArguments } from '../src/index.js';

describe('bounded subtitle inspection', () => {
  it('adds a numeric output duration only when requested', () => {
    const bounded = subtitleAssArguments('/archive/movie.mkv', 3, 600);
    expect(bounded.slice(bounded.indexOf('-t'), bounded.indexOf('-t') + 2)).toEqual(['-t', '600']);
    expect(bounded).toContain('0:3');
    expect(subtitleAssArguments('/archive/movie.mkv', 3)).not.toContain('-t');
  });

  it('rejects invalid stream and duration values before invoking FFmpeg', () => {
    expect(() => subtitleAssArguments('/archive/movie.mkv', -1, 600)).toThrow('streamIndex');
    expect(() => subtitleAssArguments('/archive/movie.mkv', 2, Number.POSITIVE_INFINITY)).toThrow('maxDurationSeconds');
    expect(() => subtitleAssArguments('/archive/movie.mkv', 2, 86_401)).toThrow('maxDurationSeconds');
  });
});
