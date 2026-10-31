import { Capacitor, registerPlugin } from '@capacitor/core';
import { createNativeApiFetch, type NativeApiRequest } from './nativeApiFetch.ts';

const nativeApi = registerPlugin<{ nativeRequest: NativeApiRequest }>('LudolumeApi');

/** One native cookie store for auth and both games on each mobile platform. */
export const apiFetch: typeof fetch = Capacitor.isNativePlatform() && ['ios', 'android'].includes(Capacitor.getPlatform())
    ? createNativeApiFetch((options) => nativeApi.nativeRequest(options))
    : (input, init) => fetch(input, init);
