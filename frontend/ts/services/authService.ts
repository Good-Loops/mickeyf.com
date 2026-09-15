/** Configured auth requests; UI/context callers own state and alerts. */
import { API_BASE, PUBLIC_API_PREVIEW } from '@/config/apiConfig';
import { createAuthApi } from './authApi.ts';
import { apiFetch } from './apiFetch.ts';

const authApi = createAuthApi(API_BASE, apiFetch);

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

// The deployed preview backend has fixed four-hour sessions, not renewal.
export const renewRequest = PUBLIC_API_PREVIEW ? authApi.verifyRequest : authApi.renewRequest;
