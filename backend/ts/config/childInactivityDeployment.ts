import { timingSafeEqual } from 'node:crypto';
import { isAccountId } from '../accounts/deletionJournal';

/** Separately controlled private journal; never reuse the unconditional deletion bucket. */
export const CHILD_RETENTION_BUCKET = 'ludolume-retention-history-1012884798546';
type Environment = Readonly<Record<string, string | undefined>>;
export type ChildInactivityDeployment = Readonly<{
    bucket: string; database: string; serverUuid: string;
    journalKey: Buffer; targetKey: Buffer; receiptKey: Buffer; brevoApiKey?: string;
}>;

/** An absent switch preserves the existing application; explicit activation is strict. */
export function loadChildInactivityDeployment(env: Environment): ChildInactivityDeployment | undefined {
    const enabled = env.CHILD_INACTIVITY_ENABLED;
    if (enabled === undefined || enabled === 'false') return undefined;
    if (enabled !== 'true') throw new Error('CHILD_INACTIVITY_ENABLED must be true or false.');
    if (env.NODE_ENV !== 'production' || env.CHILD_ONLINE_ACTIVITY_ENABLED !== 'true'
        || env.ACCOUNT_DELETION_ENABLED !== 'true' || env.APPLE_MAINTENANCE_HTTP_ENABLED !== 'true'
        || env.CHILD_RETENTION_BUCKET !== CHILD_RETENTION_BUCKET
        || !env.DB_NAME || !/^[A-Za-z0-9_]{1,64}$/u.test(env.DB_NAME)
        || !isAccountId(env.APPLE_MAINTENANCE_EXPECTED_SERVER_UUID)) {
        throw new Error('Inactivity requires the reviewed primary database, activity tracking, private journal and authenticated maintenance.');
    }
    // One managed secret holds three independently generated values to avoid
    // unnecessary per-version charges. Never log the bundle or its parts.
    const bundle = env.CHILD_INACTIVITY_KEYS;
    if (!bundle || !/^[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/u.test(bundle)) {
        throw new Error('CHILD_INACTIVITY_KEYS must contain three independently generated 32-byte hexadecimal keys.');
    }
    const [journalKey, targetKey, receiptKey] = bundle.split(':').map(value => Buffer.from(value, 'hex'));
    if (timingSafeEqual(journalKey, targetKey) || timingSafeEqual(journalKey, receiptKey)
        || timingSafeEqual(targetKey, receiptKey) || [journalKey, targetKey, receiptKey].some(key => key.every(byte => byte === 0))) throw new Error('Inactivity keys must be distinct.');
    if (!env.CHILD_WARNING_BREVO_API_KEY || !/^xkeysib-[A-Za-z0-9_-]{20,500}$/u.test(env.CHILD_WARNING_BREVO_API_KEY)) {
        throw new Error('Inactivity requires a restricted private Brevo transactional key.');
    }
    return Object.freeze({ bucket: CHILD_RETENTION_BUCKET, database: env.DB_NAME,
        serverUuid: env.APPLE_MAINTENANCE_EXPECTED_SERVER_UUID, journalKey, targetKey, receiptKey, brevoApiKey: env.CHILD_WARNING_BREVO_API_KEY });
}
