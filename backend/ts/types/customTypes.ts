/**
 * Shared/custom backend type definitions.
 *
 * Purpose:
 * - Defines compile-time contracts used across backend layers (controllers/routers/app) for consistent data shapes.
 *
 * Scope:
 * - Types only; this module has no runtime behavior.
 */

/**
 * User record shape used within the backend.
 *
 * Contract notes:
 * - Field names use snake_case to align with persisted/API representations used in this codebase.
 */
export interface User {
    user_id: number;
    user_name: string;
    email: string;
    user_password: string;
}
