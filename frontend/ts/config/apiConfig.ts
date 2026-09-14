import { Capacitor } from '@capacitor/core';
import { selectApiBase } from './apiBase.ts';

/** Environment mode: 'development' or 'production'. */
export const MODE = import.meta.env.MODE;

/** Firebase proxies the browser API without depending on third-party cookies. */
export const API_BASE = selectApiBase({
  mode: MODE,
  isNative: Capacitor.isNativePlatform(),
  developmentUrl: import.meta.env.VITE_DEV_API_URL,
  productionUrl: import.meta.env.VITE_PROD_API_URL,
});
