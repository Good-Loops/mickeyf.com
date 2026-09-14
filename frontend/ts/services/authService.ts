/** Configured auth requests; UI/context callers own state and alerts. */
import { API_BASE } from '@/config/apiConfig';
import { createAuthApi } from './authApi.ts';
import { apiFetch } from './apiFetch.ts';

export const {
    loginRequest,
    signupRequest,
    verifyRequest,
    renewRequest,
    logoutRequest,
    deleteAccountRequest,
} = createAuthApi(API_BASE, apiFetch);
