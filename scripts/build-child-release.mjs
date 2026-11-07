import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDirectory = fileURLToPath(new URL('../frontend/', import.meta.url));
const requiredSettings = {
    VITE_PROD_API_URL: 'https://mickeyf-org-j7yuum4tiq-uc.a.run.app',
    VITE_ENABLE_THREE_BOSSES_RELEASE: '1',
    VITE_ENABLE_CHILD_ONLINE_ACTIVITY: '1',
    VITE_ENABLE_CHILD_INACTIVITY_WARNING: '1',
};

export function androidReleaseEnvironment(args, environment) {
    if (!args.includes('--qualified-android') || args.length > 2 || new Set(args).size !== args.length
        || args.some(arg => !['--qualified-android', '--qualified-daily-usage'].includes(arg))) {
        throw new Error('Use --qualified-android, and --qualified-daily-usage only after its backend and release are qualified.');
    }
    const settings = { ...requiredSettings, VITE_ENABLE_CHILD_DAILY_USAGE: args.includes('--qualified-daily-usage') ? '1' : '0' };
    for (const [name, value] of Object.entries(settings)) {
        if (environment[name] && environment[name] !== value) {
            throw new Error(`${name} conflicts with the qualified release configuration.`);
        }
    }
    return { ...environment, ...settings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const env = androidReleaseEnvironment(process.argv.slice(2), process.env);
        const vite = path.join(frontendDirectory, 'node_modules', 'vite', 'bin', 'vite.js');
        const result = spawnSync(process.execPath, [vite, 'build'], { cwd: frontendDirectory, env, stdio: 'inherit' });
        if (result.error) throw result.error;
        process.exitCode = result.status ?? 1;
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
