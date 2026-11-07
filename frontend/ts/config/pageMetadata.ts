type Page = Readonly<{ path: string; title: string; description: string }>;
export type PageMetadata = Readonly<{ title: string; description: string; canonical?: string; robots: 'index, follow' | 'noindex, follow' }>;

const origin = 'https://mickeyf.com';
const home = 'Ludolume is an interactive platform for games, music, math and animations, created by Michel Fingergut of Good-Loops.';
const publicPages: readonly Page[] = [
    { path: '/', title: 'Ludolume', description: home },
    { path: '/animations', title: 'Animations | Ludolume', description: 'Explore interactive music and math animations in Ludolume.' },
    { path: '/animations/dancing-circles', title: 'Dancing Circles | Ludolume', description: 'Explore the music-reactive Dancing Circles animation in Ludolume.' },
    { path: '/animations/dancing-fractals', title: 'Dancing Fractals | Ludolume', description: 'Explore the interactive Dancing Fractals animation in Ludolume.' },
    { path: '/games', title: 'Games | Ludolume', description: 'Explore interactive games in Ludolume.' },
    { path: '/games/p4-Vega', title: 'p4-Vega | Ludolume', description: 'Play p4-Vega, an interactive game in Ludolume.' },
    { path: '/leaderboards', title: 'Leaderboards | Ludolume', description: 'Explore Ludolume game leaderboards.' },
    { path: '/connect', title: 'Connect | Ludolume', description: 'Connect with Michel Fingergut and find the Good-Loops GitHub project behind Ludolume.' },
    { path: '/privacy', title: 'Privacy | Ludolume', description: 'Read the Ludolume privacy notice and learn about account data and privacy choices.' },
    { path: '/licenses', title: 'Third-party licenses | Ludolume', description: 'Read the third-party licenses for Ludolume.' },
    { path: '/login', title: 'Log in | Ludolume', description: 'Log in to a Ludolume account.' },
    { path: '/signup', title: 'Sign up | Ludolume', description: 'Learn about creating a Ludolume account.' },
];

/** Mirror the actual router while keeping private and gated routes out of indexes. */
export function getPageMetadata(location: string, threeBossesAvailable = false): PageMetadata {
    const path = location.split(/[?#]/u, 1)[0].replace(/\/+$/u, '') || '/';
    const page = publicPages.find(item => item.path.toLowerCase() === path.toLowerCase());
    if (page) return { ...page, canonical: `${origin}${page.path}`, robots: 'index, follow' };
    if (/^\/animations\/.+/iu.test(path)) {
        const animations = publicPages[1];
        return { ...animations, canonical: `${origin}${animations.path}`, robots: 'index, follow' };
    }
    const leaderboard = /^\/leaderboards\/([a-z0-9][a-z0-9_-]*)$/iu.exec(path);
    if (leaderboard) {
        return { title: 'Game leaderboard | Ludolume', description: 'View a game leaderboard on Ludolume.',
            canonical: `${origin}/leaderboards/${leaderboard[1]}`, robots: 'index, follow' };
    }
    if (path.toLowerCase() === '/games/three-bosses' && threeBossesAvailable) {
        return { title: 'Three Bosses | Ludolume', description: 'Play Three Bosses in Ludolume.',
            canonical: `${origin}/games/three-bosses`, robots: 'index, follow' };
    }
    return { title: 'Ludolume', description: home, robots: 'noindex, follow' };
}
