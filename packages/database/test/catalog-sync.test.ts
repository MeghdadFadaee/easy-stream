import type { CatalogSnapshot } from '@easy-stream/contracts';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  prepareCatalogSync,
  syncCatalogSnapshot,
  type Database,
} from '../src/index.js';
import { mediaItems, playbackSessions, titles } from '../src/schema.js';

const snapshot: CatalogSnapshot = {
  version: 1,
  generatedAt: '2026-07-14T10:00:00.000Z',
  titles: [{
    id: '11111111-1111-5111-8111-111111111111',
    slug: 'sample-film',
    kind: 'MOVIE',
    name: { fa: 'فیلم نمونه', en: 'Sample Film' },
    playable: true,
    resumeMediaItemId: '22222222-2222-5222-8222-222222222222',
    synopsis: {},
    mediaItems: [{
      id: '22222222-2222-5222-8222-222222222222',
      kind: 'MOVIE',
      durationSeconds: 90,
      compatibility: 'COPY',
      published: true,
    }],
    updatedAt: '2026-07-14T10:00:00.000Z',
  }],
};

describe('catalog snapshot synchronization', () => {
  it('validates and maps deterministic scanner IDs and initial publication', () => {
    const prepared = prepareCatalogSync(snapshot);
    expect(prepared.titleRows).toMatchObject([{
      id: snapshot.titles[0]?.id,
      nameFa: 'فیلم نمونه',
      nameEn: 'Sample Film',
      published: true,
    }]);
    expect(prepared.mediaItemRows).toMatchObject([{
      id: snapshot.titles[0]?.mediaItems[0]?.id,
      titleId: snapshot.titles[0]?.id,
      compatibility: 'COPY',
      published: true,
    }]);
  });

  it('rejects ambiguous duplicate IDs before opening a transaction', () => {
    const duplicate = structuredClone(snapshot);
    duplicate.titles.push({ ...structuredClone(duplicate.titles[0]!), slug: 'another-slug' });
    expect(() => prepareCatalogSync(duplicate)).toThrow(/duplicate title ID/u);
  });

  it('only updates scanner-owned fields on conflicts', async () => {
    const conflicts: Array<{ table: unknown; set: Record<string, unknown> }> = [];
    const transaction = {
      async execute() {},
      insert(table: unknown) {
        return {
          values() {
            return {
              async onConflictDoUpdate(config: { set: Record<string, unknown> }) {
                conflicts.push({ table, set: config.set });
              },
            };
          },
        };
      },
    };
    const database = {
      async transaction<T>(action: (value: typeof transaction) => Promise<T>): Promise<T> {
        return action(transaction);
      },
    } as unknown as Database;

    await syncCatalogSnapshot(database, snapshot);

    expect(Object.keys(conflicts.find((entry) => entry.table === titles)!.set).sort())
      .toEqual(['kind', 'slug', 'updatedAt']);
    expect(Object.keys(conflicts.find((entry) => entry.table === mediaItems)!.set).sort())
      .toEqual([
        'compatibility',
        'durationSeconds',
        'episodeNumber',
        'kind',
        'seasonNumber',
        'titleId',
        'updatedAt',
      ]);
  });

  it('does not constrain a worker generation UUID to media_packages.id', () => {
    const configuration = getTableConfig(playbackSessions);
    const generationForeignKey = configuration.foreignKeys.some((foreignKey) =>
      foreignKey.reference().columns.includes(playbackSessions.generationId));
    expect(generationForeignKey).toBe(false);
  });
});
