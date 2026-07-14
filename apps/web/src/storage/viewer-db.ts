import type { ProgressRecord, ViewerPreferences } from '@/types'

const DATABASE_NAME = 'easy-stream-viewer'
const DATABASE_VERSION = 1
const SETTINGS_STORE = 'settings'
const PROGRESS_STORE = 'progress'

export const defaultPreferences: ViewerPreferences = {
  uiLanguage: 'fa',
  subtitleLanguage: 'fa',
  audioLanguage: 'ja',
  volume: 1,
  muted: false,
}

let databasePromise: Promise<IDBDatabase | null> | undefined
let memoryPreferences: ViewerPreferences = { ...defaultPreferences }
const memoryProgress = new Map<string, ProgressRecord>()

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }

    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
        database.createObjectStore(SETTINGS_STORE, { keyPath: 'key' })
      }
      if (!database.objectStoreNames.contains(PROGRESS_STORE)) {
        database.createObjectStore(PROGRESS_STORE, { keyPath: 'mediaItemId' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
  return databasePromise
}

async function getRecord<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const database = await openDatabase()
  if (!database) return undefined
  return new Promise((resolve) => {
    const transaction = database.transaction(storeName, 'readonly')
    const request = transaction.objectStore(storeName).get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => resolve(undefined)
  })
}

async function putRecord(storeName: string, value: unknown): Promise<void> {
  const database = await openDatabase()
  if (!database) return
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).put(value)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => resolve()
    transaction.onabort = () => resolve()
  })
}

export async function readPreferences(): Promise<ViewerPreferences> {
  const result = await getRecord<{ key: string; value: Partial<ViewerPreferences> }>(SETTINGS_STORE, 'viewer')
  if (!result) return { ...memoryPreferences }
  memoryPreferences = { ...defaultPreferences, ...result.value }
  return { ...memoryPreferences }
}

export async function writePreferences(preferences: ViewerPreferences): Promise<void> {
  memoryPreferences = { ...preferences }
  await putRecord(SETTINGS_STORE, { key: 'viewer', value: preferences })
}

export async function readProgress(mediaItemId: string): Promise<ProgressRecord | undefined> {
  const result = await getRecord<ProgressRecord>(PROGRESS_STORE, mediaItemId)
  return result ?? memoryProgress.get(mediaItemId)
}

export async function writeProgress(progress: ProgressRecord): Promise<void> {
  memoryProgress.set(progress.mediaItemId, progress)
  await putRecord(PROGRESS_STORE, progress)
}

export async function listProgress(): Promise<ProgressRecord[]> {
  const database = await openDatabase()
  if (!database) return [...memoryProgress.values()]
  return new Promise((resolve) => {
    const transaction = database.transaction(PROGRESS_STORE, 'readonly')
    const request = transaction.objectStore(PROGRESS_STORE).getAll()
    request.onsuccess = () => resolve(request.result as ProgressRecord[])
    request.onerror = () => resolve([...memoryProgress.values()])
  })
}

export function __resetMemoryStorageForTests(): void {
  memoryPreferences = { ...defaultPreferences }
  memoryProgress.clear()
}
