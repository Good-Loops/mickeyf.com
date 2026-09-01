/** Three Bosses remains opt-in in both local and production builds. */
export const isThreeBossesLocalEnabled =
    import.meta.env.DEV
    && import.meta.env.VITE_ENABLE_THREE_BOSSES_LOCAL === '1';

export const isThreeBossesReleaseEnabled =
    import.meta.env.PROD
    && import.meta.env.VITE_ENABLE_THREE_BOSSES_RELEASE === '1';

export const isThreeBossesEnabled =
    isThreeBossesLocalEnabled || isThreeBossesReleaseEnabled;

export const THREE_BOSSES_ROUTE = '/games/three-bosses';
export const THREE_BOSSES_BUILD_BASE_PATH = isThreeBossesReleaseEnabled
    ? '/unity/three-bosses/'
    : '/__local/three-bosses/';
