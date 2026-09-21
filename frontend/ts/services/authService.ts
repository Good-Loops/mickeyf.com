/** Configured auth requests; UI/context callers own state and alerts. */
import { API_BASE, LEGACY_PUBLIC_API_PREVIEW } from '@/config/apiConfig';
import { createAuthApi } from './authApi.ts';
import { apiFetch } from './apiFetch.ts';
import { createNativeAppleSession } from './nativeAppleSession.ts';
import { Capacitor } from '@capacitor/core';

const appleSession = createNativeAppleSession(API_BASE, apiFetch);
const nativeAppleChecks = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
const authApi = createAuthApi(API_BASE, apiFetch, nativeAppleChecks ? appleSession.check : undefined);
export const watchAppleCredentialChanges = appleSession.subscribe;

export const {
    loginRequest,
    signupRequest,
    verifyRequest,
    logoutRequest,
    deleteAccountRequest,
    runProviderAuthentication,
    prepareProviderLogin,
    completeProviderLogin,
    providerAccountMethodsRequest,
} = authApi;

// Only the explicitly selected legacy protocol lacks session renewal.
export const renewRequest = LEGACY_PUBLIC_API_PREVIEW ? authApi.verifyRequest : authApi.renewRequest;
