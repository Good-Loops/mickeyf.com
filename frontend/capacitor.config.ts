import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
    appId: 'com.mickeyf.app',
    appName: 'Ludolume',
    webDir: './dist',
    // Bridge diagnostics include authentication payloads, even in debug builds.
    loggingBehavior: 'none',
};

export default config;
