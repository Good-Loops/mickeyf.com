import { fixture as sessionFixture } from './session-release-fixture.mjs';
import { PROVIDER_FIXED_ENV, providerReleaseEnvironment } from '../provider-release-config.mjs';
import { providerDeploymentApproval } from '../render-frozen-backend-deploy.mjs';
import { SERVICE, fingerprint, revisionConfiguration, sessionRevisionName } from '../frozen-backend-traffic.mjs';
import { rollbackRevisionName } from '../session-backend-traffic.mjs';
export { now } from './session-release-fixture.mjs';

export function providerConfig(phase = 'active') {
    const environment = { ...PROVIDER_FIXED_ENV };
    for (const key of ['PROVIDER_AUTH_ENABLED', 'APPLE_WEB_AUTH_ENABLED', 'PROVIDER_GOOGLE_SIGNUP_ENABLED', 'PROVIDER_APPLE_SIGNUP_ENABLED',
        'PROVIDER_APPLE_DELETION_ENABLED', 'REGISTRATION_ENABLED', 'REGISTRATION_CREATION_ENABLED', 'REGISTRATION_POLICY_REVIEWED',
        'PARENT_REGISTRATION_ENABLED', 'PARENT_REGISTRATION_CREATION_ENABLED', 'PARENT_REGISTRATION_POLICY_REVIEWED', 'PARENT_SIGNED_FORMS_ENABLED',
        'PUBLIC_SCORE_PARTICIPATION_ENABLED', 'PUBLIC_SCORE_POLICY_REVIEWED', 'PUBLIC_SCORE_ASSURANCE_REVIEWED']) environment[key] = String(phase === 'active');
    if (phase === 'active') Object.assign(environment, {
        REGISTRATION_POLICY_VERSION: 'synthetic-registration-v1', REGISTRATION_COUNTRY_RULES: '{"ZZ":{"parentRequiredBelow":15}}',
        PARENT_REGISTRATION_POLICY_VERSION: 'synthetic-parent-v1', PARENT_CONSENT_VERSION: 'synthetic-parent-consent-v1',
        PARENT_CONSENT_TEXT: 'Synthetic test only: commas, quotes " and $() are data.\nSecond line.',
        PARENT_PRIVACY_NOTICE_URL: 'https://mickeyf.com/privacy', PARENT_REGISTRATION_COUNTRIES: '["ZZ"]',
        PUBLIC_SCORE_POLICY_VERSION: 'synthetic-public-v1', PUBLIC_SCORE_CONSENT_VERSION: 'synthetic-public-consent-v1',
        PUBLIC_SCORE_CONSENT_TEXT: 'Synthetic optional public participation.', PUBLIC_SCORE_PRIVACY_NOTICE_URL: 'https://mickeyf.com/privacy',
        PUBLIC_SCORE_COUNTRY_RULES: '{"ZZ":{"selfAgeBands":["minor","adult"],"parentManaged":true}}',
    });
    return { phase, environment };
}

export function fixture(phase = 'active', previousProvider) {
    const f = sessionFixture();
    f.pins.candidate.deployment.providerRelease = providerConfig(phase);
    function setEnvironment(revision, config, rollback = false) {
        const additions = providerReleaseEnvironment(config, rollback);
        const base = revision.containers[0].env.filter(item => ['NODE_ENV', 'CLOUD_SQL_CONNECTION_NAME', 'DB_USER', 'DB_NAME',
            'P4_VEGA_SCORE_SUBMISSIONS_ENABLED', 'THREE_BOSSES_RUN_SUBMISSIONS_ENABLED', 'DB_PASS', 'SESSION_SECRET'].includes(item.name));
        revision.containers[0].env = base.concat(Object.entries(additions).map(([name, value]) => ({ name, value })));
    }
    setEnvironment(f.candidate, f.pins.candidate.deployment.providerRelease);
    if (previousProvider) {
        f.pins.baseline.providerRelease = previousProvider;
        f.pins.candidate.deployment.previousProviderRelease = previousProvider;
        setEnvironment(f.baseline, previousProvider);
    }
    Object.assign(f.rollback, structuredClone(f.candidate), { name: `${SERVICE}/revisions/${rollbackRevisionName(f.pins)}`, uid: 'rollback-uid' });
    setEnvironment(f.rollback, f.pins.candidate.deployment.providerRelease, true);
    f.rollback.containers[0].env.find(e => e.name === 'SESSION_SECRET').valueSource.secretKeyRef.version = f.pins.rollback.sessionSecretVersion;
    f.service.template.containers = structuredClone(f.rollback.containers);
    f.pins.baseline.configurationSha256 = fingerprint(revisionConfiguration(f.baseline));
    f.build.substitutions._APPROVAL = providerDeploymentApproval(f.pins.candidate.deployment);
    return f;
}

export function deploymentFixture(phase = 'active', previousProvider) {
    const f = fixture(phase, previousProvider);
    for (const revision of [f.baseline, f.candidate, f.rollback]) revision.launchStage = 'GA';
    f.pins.baseline.configurationSha256 = fingerprint(revisionConfiguration(f.baseline));
    const name = sessionRevisionName(f.pins.candidate.deployment);
    f.service.launchStage = 'GA';
    f.service.template = { revision: name, containers: structuredClone(f.candidate.containers) };
    f.service.latestCreatedRevision = f.service.latestReadyRevision = `${SERVICE}/revisions/${name}`;
    f.service.traffic = f.service.traffic.filter(item => item.revision !== rollbackRevisionName(f.pins));
    f.service.trafficStatuses = structuredClone(f.service.traffic);
    f.secret = { name: 'projects/1012884798546/secrets/SESSION_SECRET/versions/18', state: 'ENABLED', createTime: '2026-09-30T19:00:00Z' };
    let exists = false;
    f.provider.getRollbackIfExists = async () => exists ? structuredClone(f.rollback) : null;
    f.provider.getSessionSecretVersion = async () => structuredClone(f.secret);
    f.provider.patchRollbackTemplate = async body => {
        f.patches.push(structuredClone(body)); exists = true;
        f.service.template = structuredClone(body.template);
        f.service.latestReadyRevision = f.service.latestCreatedRevision = `${SERVICE}/revisions/${body.template.revision}`;
        f.service.generation = f.service.observedGeneration = String(BigInt(f.service.generation) + 1n);
        f.service.etag = `etag-${f.service.generation}`;
    };
    f.provider.waitForRollback = async () => structuredClone(f.service);
    return f;
}
