/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_REDDIT_API_BASES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
