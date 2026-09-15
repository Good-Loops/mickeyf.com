/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEV_API_URL: string;
  readonly VITE_PROD_API_URL: string;
  readonly VITE_USE_PUBLIC_API?: string;
  readonly VITE_ENABLE_THREE_BOSSES_LOCAL?: string;
  readonly VITE_ENABLE_THREE_BOSSES_RELEASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
