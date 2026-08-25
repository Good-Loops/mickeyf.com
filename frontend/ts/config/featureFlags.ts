/**
 * Development-only feature flags.
 *
 * Three Bosses must remain absent from production builds until its WebGL
 * publication and backend integration receive separate approval.
 */
export const isThreeBossesLocalEnabled =
    import.meta.env.DEV
    && import.meta.env.VITE_ENABLE_THREE_BOSSES_LOCAL === '1';

export const THREE_BOSSES_LOCAL_ROUTE = '/games/three-bosses';
export const THREE_BOSSES_BUILD_BASE_PATH = '/__local/three-bosses/';
