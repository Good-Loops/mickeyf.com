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
    if (args.length !== 1 || args[0] !== '--qualified-android') {
        throw new Error('Use --qualified-android only after qualifying the production backend and release.');
    }
    for (const [name, value] of Object.entries(requiredSettings)) {
        if (environment[name] && environment[name] !== value) {
            throw new Error(`${name} conflicts with the qualified release configuration.`);
        }
    }
    return { ...environment, ...requiredSettings };
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
