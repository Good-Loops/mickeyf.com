import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PROVIDER_CREATION_FLAGS, providerConfigurationSha256, providerReleaseEnvironment } from './provider-release-config.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedServerUuid = 'd1e6865c-ecad-11ee-a6b0-42010a400002';

function runNpm(arguments_, environment) {
    return new Promise((resolveExit, reject) => {
        const child = spawn(process.execPath, [process.env.npm_execpath, ...arguments_], {
            cwd: repository, env: environment, stdio: 'inherit', shell: false,
        });
        child.once('error', () => reject(new Error('Could not start local provider development.')));
        child.once('exit', (code, signal) => resolveExit(signal ? 1 : code ?? 1));
    });
}

export async function startLocalProviderDevelopment(environment, runCommand = runNpm) {
    // The existing watcher starts alongside the server, so compile before either can use stale output.
    const buildCode = await runCommand(['--prefix', 'backend', 'run', 'build:dev'], environment);
    if (buildCode !== 0) throw new Error('Backend compilation failed; local provider services were not started.');
    return runCommand(['run', 'backend:dev:local'], environment);
}

export function localProviderEnvironment(configuration, inherited = process.env) {
    if (configuration.phase !== 'active' || inherited.K_SERVICE !== undefined
        || inherited.NODE_ENV === 'production' || inherited.LUDOLUME_ISOLATED_RUNTIME === 'true'
        || inherited.GOOGLE_APPLICATION_CREDENTIALS !== undefined
        || inherited.APPLE_SIGN_IN_PRIVATE_KEY !== undefined || inherited.APPLE_TOKEN_ENCRYPTION_KEYS !== undefined) {
        throw new Error('Local provider startup requires development with user ADC and no injected Apple keys.');
    }
    const environment = { ...inherited, ...providerReleaseEnvironment(configuration), NODE_ENV: 'development',
        DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_NAME: 'cms', DB_USER: 'cms_mickeyf',
        LUDOLUME_LOCAL_PROVIDER_RUNTIME: 'true', LUDOLUME_ISOLATED_RUNTIME: 'false',
        LUDOLUME_LOCAL_PROVIDER_EXPECTED_SERVER_UUID: expectedServerUuid,
        LUDOLUME_LOCAL_PROVIDER_MAINTENANCE_ENABLED: 'true', SSLKEYLOGFILE: '',
    };
    // This profile shares the production database. The old serving readers ignore
    // private permissions, so local account creation must wait for their replacement.
    for (const name of PROVIDER_CREATION_FLAGS) environment[name] = 'false';
    return environment;
}

export async function main(args) {
    if (args.length !== 1 || !['--plan-only', '--run'].includes(args[0])) {
        throw new Error('Use --plan-only to inspect the public profile, or --run to start local real-account development.');
    }
    const configuration = JSON.parse(await readFile(new URL('./provider-release-general.json', import.meta.url), 'utf8'));
    const environment = localProviderEnvironment(configuration);
    const plan = { mode: 'local-provider-development', publicConfigurationSha256: providerConfigurationSha256(configuration),
        database: { proxy: '127.0.0.1:3306', database: 'cms', account: 'cms_mickeyf@%', expectedServerUuid },
        httpBind: '127.0.0.1:8080', credentials: 'Existing user Application Default Credentials; consumed only by backend',
        rootEnvModified: false, signupMode: 'general-audience; no country or age questions',
        accountCreation: 'Closed in this production-database dev profile until compatible public leaderboard readers serve all traffic',
        maintenance: 'Initial and periodic bounded expiry cleanup plus due Apple revocations; requires healthy maintenance before Apple issuance',
        privateValuesIncluded: false };
    if (args[0] === '--plan-only') { console.log(JSON.stringify({ planOnly: true, ...plan })); return; }
    if (!process.env.npm_execpath) throw new Error('Start this profile with npm run backend:dev:providers.');
    console.log(JSON.stringify(plan));
    process.exitCode = await startLocalProviderDevelopment(environment);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
