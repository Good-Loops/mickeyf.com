/**
 * @packageDocumentation
 *
 * Backend contracts domain public surface.
 *
 * Responsibility:
 * - Contract-first HTTP API surface: route contracts + DTO payload types.
 * - Shared types required to reason about requests/responses.
 *
 * Non-responsibilities:
 * - Express router wiring.
 * - Controller/service implementation.
 * - Database models/entities.
 *
 * Start here:
 * - {@link RouteContract}
 * - {@link AuthRoutesContract}
 * - {@link LeaderboardRoutesContract}
 *
 * Notes:
 * - Treat contracts as versioned/stable; changes are breaking.
 * - DTOs are boundary shapes (do not rely on internal server types).
 */
export type { AuthLevel } from '../routers/routeContract';
export type { HttpMethod } from '../routers/routeContract';
export type { RouteContract } from '../routers/routeContract';
export type { AuthRoutesContract } from '../routers/authRouter.contract';
export type { LeaderboardRoutesContract } from '../routers/leaderboardRouter.contract';

export * from './contracts.support';
