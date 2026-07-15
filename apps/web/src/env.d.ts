/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_EDITION?: 'production' | 'showcase'
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
