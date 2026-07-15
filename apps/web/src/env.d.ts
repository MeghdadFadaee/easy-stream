/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_EDITION?: 'production' | 'showcase'
  readonly VITE_API_BASE_URL?: string
  readonly VITE_SHOWCASE_CATALOG_URL?: string
  readonly VITE_SHOWCASE_STATIC?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
