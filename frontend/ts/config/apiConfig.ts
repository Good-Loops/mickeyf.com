import { Capacitor } from '@capacitor/core';
import { selectApiBase } from './apiBase.ts';

/** Environment mode: 'development' or 'production'. */
export const MODE = import.meta.env.MODE;

/** Opt-in loopback preview: public accounts and scores, never the local test DB. */
export const PUBLIC_API_PREVIEW = import.meta.env.DEV
  && MODE === 'development'
  && !Capacitor.isNativePlatform()
  && import.meta.env.VITE_USE_PUBLIC_API === '1';

/** Firebase proxies the browser API without depending on third-party cookies. */
export const API_BASE = selectApiBase({
  mode: MODE,
  isNative: Capacitor.isNativePlatform(),
  developmentUrl: import.meta.env.VITE_DEV_API_URL,
  productionUrl: import.meta.env.VITE_PROD_API_URL,
  publicPreview: PUBLIC_API_PREVIEW,
});
