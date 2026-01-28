/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly GOOGLE_API_KEY: string;
  readonly VITE_DB_NAME: string;
  // more env variables...
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
