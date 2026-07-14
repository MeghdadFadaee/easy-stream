export { buildApp } from './app.js';
export { loadConfig, type ApiConfig } from './config.js';
export type {
  AppRepository,
  MediaCommandPublisher,
  MediaPreparation,
  MediaPreparationService,
  MetadataProvider,
} from './domain.js';
export { InMemoryRepository, loadCatalogSnapshot } from './repositories/in-memory.js';
export { PostgresRepository } from './repositories/postgres.js';
export {
  FilesystemCacheStatusService,
  type CacheStatusService,
  type FilesystemCacheStatusOptions,
} from './services/cache-status.js';
export {
  FileMediaPreparationService,
  BullMqMediaBridge,
  InMemoryMediaCommandPublisher,
  JsonlMediaCommandPublisher,
} from './services/media-preparation.js';
export { DisabledMetadataProvider, TmdbMetadataProvider } from './services/tmdb.js';
