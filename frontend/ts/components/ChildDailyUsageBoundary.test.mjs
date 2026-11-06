import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const key = '__dailyUsageBoundaryTest', scope = `globalThis.${key}`;
const mocks = {
    react: 'export const useRef = value => ({ current: value }); export const useCallback = fn => fn;',
    'jsx-runtime': 'export const Fragment=Symbol.for("fragment"); export const jsx=(type,props)=>({type,props}); export const jsxs=jsx;',
    'jsx-dev-runtime': 'export const Fragment=Symbol.for("fragment"); export const jsxDEV=(type,props)=>({type,props});',
    AuthContext: `export const useAuth = () => ${scope}.auth;`,
    'react-router-dom': `export const useLocation = () => ({ pathname: ${scope}.path });`,
    ChildDailyUsageGuard: 'export default "ChildDailyUsageGuard";',
};
const root = fileURLToPath(new URL('../../', import.meta.url));
async function load(enabled) {
    const server = await createViteTestServer({ root, configFile: `${root}/vite.config.ts`, appType: 'custom', logLevel: 'silent',
        define: { 'import.meta.env.VITE_ENABLE_CHILD_DAILY_USAGE': JSON.stringify(enabled) },
        server: { middlewareMode: true }, ssr: { noExternal: [/^react$/, /^react-router-dom$/] }, plugins: [{ name: 'daily-usage-boundary', enforce: 'pre',
            resolveId(source) { const name = source.replaceAll('\\', '/').split('/').at(-1).replace(/\.tsx?$/, '');
                if (Object.hasOwn(mocks, name)) return `\0boundary:${name}`; },
            load(id) { if (id.startsWith('\0boundary:')) return mocks[id.slice('\0boundary:'.length)]; },
        }] });
    return { server, Component: (await server.ssrLoadModule('/ts/components/ChildDailyUsageBoundary.tsx')).default };
}

test('usage boundary is opt-in and checks an authenticated session before showing content', async () => {
    const off = await load('0'), on = await load('1');
    try {
        globalThis[key] = { path: '/games', auth: { isAuthenticated: true, loading: true, sessionGeneration: 7, captureSessionGeneration: () => 7 } };
        assert.equal(off.Component({ children: 'CONTENT' }).props.children, 'CONTENT');
        assert.equal(on.Component({ children: 'CONTENT' }).props.role, 'status');
        globalThis[key].auth.loading = false;
        const guarded = on.Component({ children: 'CONTENT' });
        assert.equal(guarded.type, 'ChildDailyUsageGuard');
        assert.equal(guarded.props.authenticated, true);
        assert.equal(guarded.props.sessionGeneration, 7);
        assert.equal(guarded.props.captureSessionGeneration(), 7);
        assert.equal(guarded.props.children, 'CONTENT');
        for (const path of ['/account', '/privacy', '/licenses']) {
            globalThis[key].path = path;
            assert.equal(on.Component({ children: 'CONTENT' }).props.children, 'CONTENT');
        }
    } finally { delete globalThis[key]; await off.server.close(); await on.server.close(); }
});
