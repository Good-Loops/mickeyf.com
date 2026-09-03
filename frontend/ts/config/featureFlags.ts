/** Three Bosses remains opt-in in both local and production builds. */
export const isThreeBossesLocalEnabled =
    import.meta.env.DEV
    && import.meta.env.VITE_ENABLE_THREE_BOSSES_LOCAL === '1';

export const isThreeBossesReleaseEnabled =
    import.meta.env.PROD
    && import.meta.env.VITE_ENABLE_THREE_BOSSES_RELEASE === '1';

export const isThreeBossesEnabled =
    isThreeBossesLocalEnabled || isThreeBossesReleaseEnabled;

const THREE_BOSSES_MOBILE_PREVIEW_PARAMETER = 'three-bosses-mobile-preview';

/**
 * Allows a physical mobile browser to exercise the unreleased touch HUD
 * through the local development server. The existing local feature gate is
 * authoritative, so the query parameter can never unlock production.
 */
export const isThreeBossesMobilePreviewRequested = (
    search = typeof window === 'undefined' ? '' : window.location.search,
    localEnabled = isThreeBossesLocalEnabled,
): boolean => (
    localEnabled
    && new URLSearchParams(search).get(THREE_BOSSES_MOBILE_PREVIEW_PARAMETER) === '1'
);

export const THREE_BOSSES_ROUTE = '/games/three-bosses';
export const THREE_BOSSES_BUILD_BASE_PATH = isThreeBossesReleaseEnabled
    ? '/unity/three-bosses/'
    : '/__local/three-bosses/';
