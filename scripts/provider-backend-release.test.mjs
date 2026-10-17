import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { providerConfig, fixture, deploymentFixture, now, androidPresenterPins } from './test-support/provider-release-fixture.mjs';
import { providerReleaseEnvironment, providerConfigurationSha256, PROVIDER_CREATION_FLAGS,
    PROVIDER_ANDROID_PRESENTER_PINS, validateAndroidPresenterPins } from './provider-release-config.mjs';
import { providerDeploymentApproval, renderProviderBackendDeployConfig, resolveProviderDeploymentSteps,
    renderSessionBackendDeployConfig, sessionDeploymentApproval, validateProviderPins, frozenDeploymentStepsSha256 } from './render-frozen-backend-deploy.mjs';
import { fingerprint, SERVICE, sessionRevisionName, revisionConfiguration } from './frozen-backend-traffic.mjs';
import { planProviderTraffic, applyProviderTraffic, planSessionTraffic, validateProviderRollback, captureProviderBaseline } from './session-backend-traffic.mjs';
import { planProviderRollbackDeployment, applyProviderRollbackDeployment, applyRollbackDeployment,
    createProviderRollbackDeploymentProvider } from './session-backend-rollback.mjs';
import { main } from './provider-backend-release.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const input = { canonical: read('../cloudbuild.deploy.yaml'), candidate: read('../cloudbuild.candidate.yaml'),
    preflight: read('./render-frozen-backend-deploy.preflight.py') };
const render = pins => renderProviderBackendDeployConfig({ ...input, pins });
function python(code, data = {}) {
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', 'import json,sys\ndata=json.load(sys.stdin)\n' + code],
        { input: JSON.stringify(data), encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); return result.stdout;
}

test('preparation is explicit and closed; active policies have no implicit country or consent defaults', () => {
    const prepared = providerReleaseEnvironment(providerConfig('prepare'));
    assert.equal(prepared.PROVIDER_AUTH_ENABLED, 'false'); assert.equal(prepared.APPLE_NOTIFICATIONS_ENABLED, 'true');
    for (const mutate of [c => { delete c.environment.REGISTRATION_COUNTRY_RULES; }, c => { c.environment.EXTRA = 'injected'; },
        c => { c.environment.APPLE_SIGN_IN_PRIVATE_KEY = 'private'; }, c => { c.environment.GOOGLE_ANDROID_CLIENT_ID = 'unapproved'; },
        c => { c.environment.REGISTRATION_COUNTRY_RULES = '{"ZZ":{"parentRequiredBelow":0}}'; },
        c => { c.environment.PUBLIC_SCORE_COUNTRY_RULES = '{"US":{"selfAgeBands":[],"parentManaged":true}}'; },
        c => { c.environment.PARENT_PRIVACY_NOTICE_URL = 'https://evil.invalid/privacy'; },
        c => { c.environment.PARENT_PRIVACY_NOTICE_URL = 'https://mickeyf.com/%0aprivacy'; },
        c => { c.environment.APPLE_SIGN_IN_PRIVATE_KEY_SECRET_VERSION = c.environment.APPLE_SIGN_IN_PRIVATE_KEY_SECRET_VERSION.replace('/1', '/latest'); }]) {
        const config = providerConfig(); mutate(config); assert.throws(() => providerReleaseEnvironment(config));
    }
    const config = providerConfig('prepare'); config.environment.APPLE_WEB_AUTH_ENABLED = 'true';
    assert.throws(() => providerReleaseEnvironment(config), /keep.*closed/);
});

test('Android release activation remains blocked without actual reviewed Play certificate/OAuth pins', () => {
    assert.deepEqual(PROVIDER_ANDROID_PRESENTER_PINS, []);
    assert.equal(Object.isFrozen(PROVIDER_ANDROID_PRESENTER_PINS), true);
    const config = JSON.parse(read('./provider-release-general.json'));
    assert.equal(providerConfigurationSha256(config), 'cd57fc2f92f300610d21a98c5fa88476ccd20f8ed82e3974c4e0e96a09b95d01');
    const approvedOnlyInTests = androidPresenterPins();
    for (const changes of [
        { GOOGLE_ANDROID_CLIENT_ID: approvedOnlyInTests[0].clientId },
        { GOOGLE_ANDROID_CLIENT_IDS: JSON.stringify(approvedOnlyInTests.map(pin => pin.clientId)) },
        { GOOGLE_ANDROID_CLIENT_IDS: '[]' },
    ]) {
        const changed = structuredClone(config); Object.assign(changed.environment, changes);
        assert.notEqual(providerConfigurationSha256(changed), providerConfigurationSha256(config));
        assert.throws(() => providerReleaseEnvironment(changed, false, approvedOnlyInTests), /reviewed Play certificate/);
        assert.throws(() => providerReleaseEnvironment(changed, true), /reviewed Play certificate/);
        for (const property of ['providerRelease', 'previousProviderRelease']) {
            const pins = fixture('active', providerConfig('prepare')).pins.candidate.deployment;
            pins[property] = changed;
            assert.throws(() => render(pins), /reviewed Play certificate/);
        }
    }
});

test('public Android pin validation binds distinct package, Play certificates and exact OAuth presenters', () => {
    const env = providerConfig().environment;
    for (const count of [1, 8]) {
        const pins = androidPresenterPins(count), ids = pins.map(pin => pin.clientId);
        assert.deepEqual(validateAndroidPresenterPins({ ...env, GOOGLE_ANDROID_CLIENT_IDS: JSON.stringify(ids) }, pins), ids);
        assert.deepEqual(validateAndroidPresenterPins({ ...env, GOOGLE_ANDROID_CLIENT_ID: ids[0] }, pins), [ids[0]]);
    }
    const pins = androidPresenterPins(), ids = pins.map(pin => pin.clientId);
    for (const additions of [
        { GOOGLE_ANDROID_CLIENT_ID: ids[0], GOOGLE_ANDROID_CLIENT_IDS: JSON.stringify(ids) },
        ...['not json', 'null', '{}', JSON.stringify(ids[0]), '[]', JSON.stringify([...ids, ids[0]]),
            ' '.repeat(4097) + JSON.stringify(ids),
            JSON.stringify([env.GOOGLE_WEB_CLIENT_ID]), JSON.stringify([env.GOOGLE_IOS_CLIENT_ID]),
            JSON.stringify([`${ids[0]}\n`]), JSON.stringify([null]), JSON.stringify(['foreign.apps.googleusercontent.com'])]
            .map(GOOGLE_ANDROID_CLIENT_IDS => ({ GOOGLE_ANDROID_CLIENT_IDS })),
    ]) assert.throws(() => validateAndroidPresenterPins({ ...env, ...additions }, pins));
    for (const changed of [null, androidPresenterPins(9), [pins[0], pins[0]],
        ...[{ packageName: 'com.other.app' }, { signer: 'upload' }, { certificateSha1: 'AA:BB' },
            { certificateSha256: 'b'.repeat(64) }, { certificateSha1: null }, { certificateSha1: 'A'.repeat(40) + '\n' },
            { certificateSha256: 'B'.repeat(64) + '\n' }, { extra: 'unknown' },
            { clientId: '999999999999-other.apps.googleusercontent.com' }, { clientId: env.GOOGLE_IOS_CLIENT_ID }]
            .map(change => [{ ...pins[0], ...change }]),
        [pins[0], { ...pins[1], certificateSha1: pins[0].certificateSha1 }],
        [pins[0], { ...pins[1], certificateSha256: pins[0].certificateSha256 }],
    ]) assert.throws(() => validateAndroidPresenterPins({ ...env, GOOGLE_ANDROID_CLIENT_ID: ids[0] }, changed));
});

test('general signup has a separate version, no new parent-account creation, and retains rollback filtering', () => {
    const config = JSON.parse(read('./provider-release-general.json'));
    const environment = providerReleaseEnvironment(config);
    assert.equal(environment.REGISTRATION_GENERAL_AUDIENCE_ENABLED, 'true');
    assert.equal(environment.PARENT_REGISTRATION_CREATION_ENABLED, 'false');
    assert.equal(environment.PARENT_SIGNED_FORMS_ENABLED, 'true');
    assert.equal(environment.PUBLIC_SCORE_PARTICIPATION_ENABLED, 'true');
    const rollback = providerReleaseEnvironment(config, true);
    for (const name of PROVIDER_CREATION_FLAGS) assert.equal(rollback[name], 'false');
    assert.equal(rollback.REGISTRATION_GENERAL_AUDIENCE_ENABLED, 'true');
    for (const changes of [
        { REGISTRATION_GENERAL_AUDIENCE_ENABLED: 'false' },
        { REGISTRATION_GENERAL_AUDIENCE_POLICY_REVIEWED: 'false' },
        { REGISTRATION_GENERAL_AUDIENCE_POLICY_VERSION: environment.REGISTRATION_POLICY_VERSION },
        { PARENT_REGISTRATION_CREATION_ENABLED: 'true' },
    ]) {
        const changed = structuredClone(config);
        Object.assign(changed.environment, changes);
        assert.throws(() => providerReleaseEnvironment(changed));
    }
    const incomplete = structuredClone(config);
    delete incomplete.environment.REGISTRATION_GENERAL_AUDIENCE_POLICY_VERSION;
    assert.throws(() => providerReleaseEnvironment(incomplete));
    const pins = fixture().pins.candidate.deployment;
    pins.providerRelease = config;
    const smoke = render(pins).steps[7].args.slice(3).join('');
    assert.match(smoke, /"mode":"general-audience"/u);
    python('compile(data["smoke"],"general-smoke","exec")', { smoke });
});

test('provider rendering retains canonical scan/no-traffic checks and transports consent only as data', () => {
    const pins = fixture().pins.candidate.deployment; const config = render(pins);
    const bundle = JSON.parse(Buffer.from(config.steps[0].args.slice(3).join(''), 'base64'));
    assert.deepEqual(bundle.pins.providerRelease, pins.providerRelease);
    assert.match(bundle.preflight, /PROVIDER_RELEASE = True/);
    assert.match(config.steps[2].args[1], /FINISHED_SUCCESS/);
    assert.match(config.steps[3].args[1], /counts\["HIGH"\] or counts\["CRITICAL"\]/);
    assert.match(config.steps[5].args[1], /--env-vars-file=\/workspace\/provider-environment.json/);
    assert.doesNotMatch(config.steps[5].args[1], /--set-env-vars=/);
    assert.match(config.steps[5].args[1], /--no-traffic --tag=/);
    assert.match(config.steps[5].args[1], /before-deploy/);
    assert.match(config.steps[6].args[1], /after-deploy/);
    for (const step of config.steps) for (const arg of step.args) {
        assert.ok(arg.length <= 10_000); assert.ok(!arg.includes(pins.providerRelease.environment.PARENT_CONSENT_TEXT));
    }
    python('compile(data["preflight"],"preflight","exec")\ncompile(data["contract"],"contract","exec")',
        { preflight: bundle.preflight, contract: config.steps[4].args[1] });
    python('compile(data["smoke"],"smoke","exec")', { smoke: config.steps[7].args.slice(3).join('') });
    assert.match(config.steps[7].args.slice(3).join(''), /runtime credential loading may be unavailable/);
    assert.throws(() => renderSessionBackendDeployConfig({ ...input, pins }), /eight reviewed/);
});

test('materialized scripts compile and the complete contract writes exact environment data without shell execution', () => {
    const pins = fixture('active', providerConfig('prepare')).pins.candidate.deployment;
    const config = render(pins);
    python(String.raw`
import builtins, os, tempfile, subprocess
from pathlib import Path
from unittest.mock import patch
with tempfile.TemporaryDirectory() as folder:
    root=Path(folder)
    def target(path):
        assert isinstance(path,str) and path.startswith('/workspace/')
        return root / path.removeprefix('/workspace/')
    original_open=os.open
    with patch.object(sys,'argv',['-c',*data['materializer'][2:]]), patch.object(os,'open',lambda path,*a:original_open(target(path),*a)):
        exec(compile(data['materializer'][1],'materializer','exec'),{'__name__':'__main__'})
    pins=json.loads((root/'session-pins.json').read_text())
    assert pins['providerRelease']==data['pins']['providerRelease']
    compile((root/'session-preflight.py').read_text(),'preflight','exec')
    state={'commit':pins['sourceCommit'],'build_id':pins['sourceBuildId'],'digest':pins['imageDigest']}
    (root/'verified-stage-a.json').write_text(json.dumps(state))
    env=[{'name':key,'value':value} for key,value in pins['previousProviderRelease']['environment'].items()]
    traffic=[{'revisionName':'mickeyf-org-previous','percent':100}]
    service={'metadata':{'uid':'uid','generation':'146'},'spec':{'template':{'spec':{'containers':[{'env':env}]}},'traffic':traffic},
        'status':{'observedGeneration':'146','conditions':[{'type':'Ready','status':'True'}],'traffic':traffic}}
    revisions=[{'metadata':{'name':'mickeyf-org-previous'},'spec':{'containers':[{'env':env}]}}]
    def cloud(args,**kwargs):
        assert args[:2]==['gcloud','run']
        return subprocess.CompletedProcess(args,0,stdout=json.dumps(service if args[2]=='services' else revisions))
    actual_open=builtins.open
    def files(path,*a,**kw): return actual_open(target(path),*a,**kw)
    with patch.object(builtins,'open',files),patch.object(subprocess,'run',cloud),patch.dict(os.environ,data['environment'],clear=True):
        exec(compile(data['contract'],'contract','exec'),{'__name__':'__main__'})
    output=json.loads((root/'provider-environment.json').read_text())
    for name,value in pins['providerRelease']['environment'].items(): assert output[name]==value
    assert output['NODE_ENV']=='production' and 'SESSION_SECRET' not in output
    assert output['PARENT_CONSENT_TEXT']==data['pins']['providerRelease']['environment']['PARENT_CONSENT_TEXT']
`, { pins, materializer: config.steps[0].args, contract: config.steps[4].args[1],
        environment: Object.fromEntries(config.steps[4].env.map(item => { const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)]; })) });
    const directory = mkdtempSync(join(tmpdir(), 'provider-render-syntax-'));
    for (const [index, step] of config.steps.entries()) if (step.entrypoint === 'bash') {
        const script = join(directory, `${index}.sh`);
        writeFileSync(script, step.args[1].replaceAll('$$', '$'));
        const result = spawnSync(process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash', ['-n', script], { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, result.stderr);
    }
});

test('public capability smoke rejects an Apple credential outage despite a healthy HTTP service', () => {
    const pins = fixture().pins.candidate.deployment;
    const smoke = render(pins).steps[7].args.slice(3).join('');
    const start = smoke.indexOf('with open("/workspace/session-pins.json"');
    const probe = smoke.slice(start, smoke.indexOf('print("Tagged candidate anonymous HTTP and public capability checks', start));
    assert.ok(start > 0);
    python(String.raw`
from io import StringIO
from email.message import Message
from unittest.mock import patch
env=data['pins']['providerRelease']['environment']
clients=[{'clientKey':'google-web','provider':'google','platform':'web','clientId':env['GOOGLE_WEB_CLIENT_ID'],'signup':True},
    {'clientKey':'google-ios','provider':'google','platform':'ios','clientId':env['GOOGLE_WEB_CLIENT_ID'],'signup':True},
    {'clientKey':'apple-ios','provider':'apple','platform':'ios','clientId':env['APPLE_IOS_BUNDLE_ID'],'signup':True},
    {'clientKey':'apple-web','provider':'apple','platform':'web','clientId':env['APPLE_WEB_SERVICES_ID'],'redirectUri':env['APPLE_WEB_REDIRECT_URI'],'signup':True}]
def reject(message): raise ValueError(message)
def request(path,status):
    assert status==200
    body={'clients':clients} if path=='/auth/providers/config' else {'enabled':True,'policyVersion':env['REGISTRATION_POLICY_VERSION'],
        'parentRegistrationAvailable':False,'countries':[{'country':'ZZ','parentRequiredBelow':15,'adultFrom':18}]}
    return body,Message()
ns={'json':json,'request':request,'reject':reject,'no_store':lambda headers:True,'open':lambda *a,**kw:StringIO(json.dumps(data['pins']))}
exec(compile(data['probe'],'public-probe','exec'),ns)
clients[:]=[client for client in clients if client['provider']=='google']
try: exec(compile(data['probe'],'public-probe','exec'),ns)
except ValueError as error: assert 'runtime credential loading' in str(error)
else: raise AssertionError('Missing Apple capability passed the active release gate')
`, { pins, probe });
});

test('public smoke expects exactly one Android capability only when Android configuration is present', () => {
    // Exercise the offline HTTP contract with synthetic settings. The real renderer above refuses
    // these settings while the reviewed Android pin table is empty.
    const pins = fixture().pins.candidate.deployment;
    const smoke = render(pins).steps[7].args.slice(3).join('');
    const start = smoke.indexOf('with open("/workspace/session-pins.json"');
    const probe = smoke.slice(start, smoke.indexOf('print("Tagged candidate anonymous HTTP and public capability checks', start));
    python(String.raw`
from io import StringIO
from email.message import Message
env=data['pins']['providerRelease']['environment']
base=[{'clientKey':'google-web','provider':'google','platform':'web','clientId':env['GOOGLE_WEB_CLIENT_ID'],'signup':True},
    {'clientKey':'google-ios','provider':'google','platform':'ios','clientId':env['GOOGLE_WEB_CLIENT_ID'],'signup':True},
    {'clientKey':'apple-ios','provider':'apple','platform':'ios','clientId':env['APPLE_IOS_BUNDLE_ID'],'signup':True},
    {'clientKey':'apple-web','provider':'apple','platform':'web','clientId':env['APPLE_WEB_SERVICES_ID'],'redirectUri':env['APPLE_WEB_REDIRECT_URI'],'signup':True}]
android={'clientKey':'google-android','provider':'google','platform':'android','clientId':env['GOOGLE_WEB_CLIENT_ID'],'signup':True}
clients=base[:]
def reject(message): raise ValueError(message)
def request(path,status):
    assert status==200
    body={'clients':clients} if path=='/auth/providers/config' else {'enabled':True,'policyVersion':env['REGISTRATION_POLICY_VERSION'],
        'parentRegistrationAvailable':False,'countries':[{'country':'ZZ','parentRequiredBelow':15,'adultFrom':18}]}
    return body,Message()
ns={'json':json,'request':request,'reject':reject,'no_store':lambda headers:True,'open':lambda *a,**kw:StringIO(json.dumps(data['pins']))}
def verify(expected):
    try: exec(compile(data['probe'],'public-probe','exec'),ns)
    except ValueError:
        assert not expected
    else: assert expected
verify(True)
clients.append(android); verify(False)
for name,value in [('GOOGLE_ANDROID_CLIENT_ID',data['androidIds'][0]),('GOOGLE_ANDROID_CLIENT_IDS',json.dumps(data['androidIds']))]:
    env[name]=value; verify(True)
    clients[:]=base; verify(False)
    clients[:]=base+[dict(android,clientId=data['androidIds'][0])]; verify(False)
    clients[:]=base+[android,android]; verify(False)
    clients[:]=base+[dict(android,signup=False)]; verify(False)
    clients[:]=base+[android,dict(android,clientKey='foreign')]; verify(False)
    clients[:]=base+[android]; del env[name]
verify(False)
clients[:]=base; verify(True)
`, { pins, probe, androidIds: androidPresenterPins(8).map(pin => pin.clientId) });
});

test('full-size consent and country configuration stay within Cloud Build argument limits', () => {
    const pins = fixture().pins.candidate.deployment;
    const countries = {};
    for (let a = 65; a <= 90 && Object.keys(countries).length < 249; a++) for (let b = 65; b <= 90 && Object.keys(countries).length < 249; b++) countries[String.fromCharCode(a, b)] = { parentRequiredBelow: 15 };
    const env = pins.providerRelease.environment;
    env.REGISTRATION_COUNTRY_RULES = JSON.stringify(countries);
    env.PARENT_REGISTRATION_COUNTRIES = JSON.stringify(Object.keys(countries));
    env.PUBLIC_SCORE_COUNTRY_RULES = JSON.stringify(Object.fromEntries(Object.keys(countries).map(c => [c, { selfAgeBands: ['adult'], parentManaged: true }])));
    env.PARENT_CONSENT_TEXT = env.PUBLIC_SCORE_CONSENT_TEXT = 'é'.repeat(8000);
    const config = render(pins); assert.ok(config.steps.every(s => s.args.every(a => a.length <= 10_000)));
});

test('provider approval binds current and previous configurations and cannot be reused by session-only tooling', () => {
    const pins = fixture('active', providerConfig('prepare')).pins.candidate.deployment;
    const config = render(pins); const approval = providerDeploymentApproval(pins);
    const dispatch = { buildId: '22222222-2222-4222-8222-222222222222', deploymentTriggerId: '33333333-3333-4333-8333-333333333333', approval };
    assert.throws(() => resolveProviderDeploymentSteps(config.steps, { ...dispatch, approval: sessionDeploymentApproval({ ...pins, providerRelease: undefined }) }));
    const changed = structuredClone(pins); changed.providerRelease.environment.PARENT_CONSENT_TEXT += 'changed';
    assert.notEqual(providerDeploymentApproval(changed), approval);
    delete changed.previousProviderRelease; assert.notEqual(providerDeploymentApproval(changed), approval);
    assert.match(frozenDeploymentStepsSha256(resolveProviderDeploymentSteps(config.steps, dispatch)), /^[a-f0-9]{64}$/);
    const bundle = JSON.parse(Buffer.from(config.steps[0].args.slice(3).join(''), 'base64'));
    python(String.raw`
from io import StringIO
from unittest.mock import patch
ns={"__name__":"review"}; exec(compile(data["source"],"preflight","exec"),ns)
class CloudReached(Exception): pass
def cloud(*args): raise CloudReached()
def check(approval):
    with patch.dict(ns,{"open":lambda *a,**kw:StringIO(json.dumps(data["pins"])),"command":cloud}), patch.object(sys,"argv",["p","/workspace/session-pins.json",data["dispatch"]["buildId"],data["dispatch"]["deploymentTriggerId"],approval,"initial"]):
        try: ns["main"]()
        except CloudReached: return True
        except SystemExit: return False
assert check(data["dispatch"]["approval"])
assert not check(data["dispatch"]["approval"].replace("provider-zero-traffic", "session-zero-traffic"))
data["pins"]["providerRelease"]["environment"]["PARENT_CONSENT_TEXT"] += "changed"
assert not check(data["dispatch"]["approval"])
`, { source: bundle.preflight, pins: validateProviderPins(pins), dispatch });
});

test('previous-provider contract rejects silent activation drift and preserves policy punctuation exactly', () => {
    const pins = fixture('active', providerConfig('prepare')).pins.candidate.deployment;
    const config = render(pins);
    python(String.raw`
from io import StringIO
from unittest.mock import patch
ns={"__name__":"review"}; exec(compile(data["source"],"contract","exec"),ns)
previous=data["pins"]["previousProviderRelease"]["environment"]
container={"env":[{"name":key,"value":value} for key,value in previous.items()]}
with patch.dict(ns,{"open":lambda *a,**kw:StringIO(json.dumps(data["pins"]))}):
    ns["check_provider_baseline"](container)
    container["env"].append({"name":"UNREVIEWED","value":"true"})
    try: ns["check_provider_baseline"](container)
    except SystemExit: pass
    else: raise AssertionError("unknown prior environment accepted")
`, { source: config.steps[4].args[1], pins: validateProviderPins(pins) });
});

test('compatible rollback uses candidate image and retains management/cleanup while closing all creation gates', async () => {
    const f = deploymentFixture(); const traffic = structuredClone(f.service.traffic);
    const plan = await planProviderRollbackDeployment(f.provider, f.pins, now);
    assert.equal(plan.schemaVersion, 2); assert.equal(f.patches.length, 0);
    assert.equal(plan.request.template.containers[0].image, f.candidate.containers[0].image);
    const env = Object.fromEntries(plan.request.template.containers[0].env.map(e => [e.name, e.value]));
    for (const key of PROVIDER_CREATION_FLAGS) assert.equal(env[key], 'false');
    for (const key of ['REGISTRATION_ENABLED', 'PARENT_REGISTRATION_ENABLED', 'PROVIDER_AUTH_ENABLED', 'APPLE_WEB_AUTH_ENABLED',
        'ACCOUNT_DELETION_ENABLED', 'APPLE_NOTIFICATIONS_ENABLED', 'APPLE_MAINTENANCE_HTTP_ENABLED']) assert.equal(env[key], 'true');
    await assert.rejects(applyRollbackDeployment(f.provider, plan, fingerprint(plan), now), /another operation/);
    const result = await applyProviderRollbackDeployment(f.provider, plan, fingerprint(plan), now + 1000);
    assert.equal(result.trafficUnchanged, true); assert.equal(f.patches.length, 1); assert.deepEqual(f.service.traffic, traffic);
    const promotion = await planProviderTraffic(f.provider, f.pins, 'promote', now + 2000);
    assert.equal(promotion.desiredTraffic[0].revision, sessionRevisionName(f.pins.candidate.deployment));
    await assert.rejects(planSessionTraffic(f.provider, f.pins, 'promote', now), /eight reviewed/);
});

test('promotion then a fresh rollback plan changes traffic once per approved operation', async () => {
    const f = fixture(); const promotion = await planProviderTraffic(f.provider, f.pins, 'promote', now);
    await applyProviderTraffic(f.provider, promotion, fingerprint(promotion), now + 1000);
    const rollback = await planProviderTraffic(f.provider, f.pins, 'rollback', now + 2000);
    await applyProviderTraffic(f.provider, rollback, fingerprint(rollback), now + 3000);
    assert.equal(f.patches.length, 2); assert.equal(f.service.traffic[0].revision, f.rollback.name.split('/').at(-1));
});

for (const [name, mutate] of [
    ['old image', f => { f.rollback.containers[0].image = f.baseline.containers[0].image; }],
    ['management disabled', f => { f.rollback.containers[0].env.find(e => e.name === 'PARENT_REGISTRATION_ENABLED').value = 'false'; }],
    ['creation reopened', f => { f.rollback.containers[0].env.find(e => e.name === 'REGISTRATION_CREATION_ENABLED').value = 'true'; }],
    ['cleanup disabled', f => { f.rollback.containers[0].env.find(e => e.name === 'APPLE_MAINTENANCE_HTTP_ENABLED').value = 'false'; }],
    ['unapproved policy', f => { f.candidate.containers[0].env.find(e => e.name === 'PARENT_CONSENT_TEXT').value += 'drift'; }],
    ['wrong receipt', f => { f.build.substitutions._APPROVAL = 'legacy'; }],
]) test(`${name} refuses provider promotion without a mutation`, async () => {
    const f = fixture(); mutate(f); await assert.rejects(planProviderTraffic(f.provider, f.pins, 'promote', now)); assert.equal(f.patches.length, 0);
});

test('preparation baseline supports a separately reviewed active transition, never an implicit policy replacement', async () => {
    const f = fixture('active', providerConfig('prepare'));
    await planProviderTraffic(f.provider, f.pins, 'promote', now);
    const baselineService = structuredClone(f.service);
    baselineService.traffic = baselineService.trafficStatuses = [baselineService.traffic[0]];
    const captured = await captureProviderBaseline({ ...f.provider, getService: async () => baselineService }, providerConfig('prepare'));
    assert.deepEqual(captured, f.pins.baseline);
    f.pins.candidate.deployment.previousProviderRelease.environment.PROVIDER_AUTH_ENABLED = 'true';
    await assert.rejects(planProviderTraffic(f.provider, f.pins, 'promote', now));
});

test('stale or edited plans and ambiguous mutation results never retry', async () => {
    const f = fixture(); const plan = await planProviderTraffic(f.provider, f.pins, 'promote', now);
    await assert.rejects(applyProviderTraffic(f.provider, plan, fingerprint(plan), now + 300001), /stale/);
    const changed = structuredClone(plan); changed.desiredTraffic[0].revision = f.pins.baseline.revisionName;
    await assert.rejects(applyProviderTraffic(f.provider, changed, fingerprint(changed), now), /drift/);
    f.provider.patchTraffic = async body => { f.patches.push(body); throw new Error('response lost'); };
    await assert.rejects(applyProviderTraffic(f.provider, plan, fingerprint(plan), now), /inspect live state/);
    assert.equal(f.patches.length, 1);
});

test('rollback transport checks the candidate again and permits only a template patch preserving traffic', async () => {
    const f = deploymentFixture(); const plan = await planProviderRollbackDeployment(f.provider, f.pins, now);
    const calls = [];
    const provider = createProviderRollbackDeploymentProvider('x'.repeat(30), async (url, options) => {
        calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
        const body = options.method === 'PATCH' ? { name: 'projects/noted-reef-387021/locations/us-central1/operations/test' }
            : url.includes('/builds/') ? f.build : url.endsWith(f.pins.baseline.revisionName) ? f.baseline : f.candidate;
        return new Response(JSON.stringify(body), { status: 200 });
    });
    await provider.patchRollbackTemplate(plan.request, f.pins, Date.now() + 60000);
    assert.equal(calls.filter(c => c.method === 'PATCH').length, 1);
    assert.equal(calls.at(-1).url, `https://run.googleapis.com/v2/${SERVICE}?updateMask=template`);
    assert.equal(calls.at(-1).body.traffic, undefined);
    const wrong = structuredClone(plan.request); wrong.template.containers[0].image = f.baseline.containers[0].image;
    await assert.rejects(provider.patchRollbackTemplate(wrong, f.pins, Date.now() + 60000), /exact reviewed/);
    assert.equal(calls.filter(c => c.method === 'PATCH').length, 1);
});

test('provider CLI refuses missing/legacy confirmations before obtaining cloud credentials', async () => {
    await assert.rejects(main([]), /explicit provider operation/);
    const f = fixture(); const plan = await planProviderTraffic(f.provider, f.pins, 'promote', now);
    const directory = mkdtempSync(join(tmpdir(), 'provider-release-cli-')); const file = join(directory, 'plan.json');
    writeFileSync(file, JSON.stringify(plan));
    await assert.rejects(main(['apply-traffic', '--plan', file, '--confirm-plan', fingerprint(plan), '--confirm-session-promotion']), /Missing option value|Unexpected/);
    await assert.rejects(main(['apply-traffic', '--plan', file, '--confirm-plan', fingerprint(plan), '--confirm-provider-rollback']), /Unexpected/);
});
