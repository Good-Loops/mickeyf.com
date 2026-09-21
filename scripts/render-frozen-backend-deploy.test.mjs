import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { deploymentStepsFingerprint } from './frozen-backend-traffic.mjs';
import {
    CANONICAL_SHA256, frozenDeploymentStepsSha256, renderFrozenBackendDeployConfig,
    resolveFrozenDeploymentSteps, validateFrozenPins,
    accountDeletionEnvironment, ACCOUNT_DELETION_JOURNAL_BUCKET, ORIGINAL_ACCOUNT_IDENTITY_EPOCH,
    googleSignInEnvironment, APPROVED_GOOGLE_WEB_CLIENT_ID,
    frozenDeploymentApproval, validateSessionSecretVersion,
} from './render-frozen-backend-deploy.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const preflight = read('./render-frozen-backend-deploy.preflight.py');
const pins = {
    sourceBuildId: '123e4567-e89b-42d3-a456-426614174000', sourceCommit: 'a'.repeat(40),
    imageDigest: `sha256:${'b'.repeat(64)}`, sourceTriggerId: '648fadca-3cd1-4b57-9d35-0f62a1468443',
    sourceTriggerName: 'feature-new-leaderboard-candidate', sourceRef: 'refs/heads/feature/three-bosses-polish',
    deploymentTriggerName: 'frozen-backend-receipts', sessionSecretVersion: '2',
};
const input = { canonical: read('../cloudbuild.deploy.yaml'), candidate: read('../cloudbuild.candidate.yaml'), preflight, pins };
const config = renderFrozenBackendDeployConfig(input);
const buildId = '223e4567-e89b-42d3-a456-426614174000';
const deploymentTriggerId = '323e4567-e89b-42d3-a456-426614174000';
const approval = frozenDeploymentApproval(pins);
const resolved = resolveFrozenDeploymentSteps(config.steps, { buildId, deploymentTriggerId, approval });

function python(code, payload) {
    const program = 'import json, sys\npayload=json.load(sys.stdin)\nnamespace={"__name__":"reviewed_preflight"}\n'
        + 'exec(compile(payload["source"],"reviewed-preflight.py","exec"),namespace)\nglobals().update(namespace)\n' + code;
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', program], {
        input: JSON.stringify({ source: preflight, ...payload }), encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.error, undefined);
    return result;
}

test('renderer preserves main-only canonical policy and rejects any unreviewed input change', () => {
    assert.equal(CANONICAL_SHA256.length, 64);
    assert.throws(() => renderFrozenBackendDeployConfig({ ...input, canonical: input.canonical + '\n' }), /hash changed/u);
    assert.throws(() => renderFrozenBackendDeployConfig({ ...input, candidate: input.candidate.replace('VERIFIED', 'NOT_VERIFIED') }), /hash changed/u);
    assert.deepEqual(renderFrozenBackendDeployConfig({ ...input, canonical: input.canonical.replace(/\r?\n/gu, '\r\n') }), config);
});

test('only exact reviewed work-branch pins render; main triggers and shell injection are rejected', () => {
    for (const prefix of ['feature', 'improvement', 'fix']) {
        const sourceRef = `refs/heads/${prefix}/reviewed-backend-change`;
        assert.equal(validateFrozenPins({ ...pins, sourceRef }).sourceRef, sourceRef);
    }
    for (const change of [
        { sourceCommit: 'main' }, { imageDigest: 'latest' }, { sourceBuildId: 'INVALID' },
        { sourceTriggerName: "x'; echo y" }, { sourceRef: 'refs/heads/main' }, { sourceRef: 'refs/heads/feature/../main' },
        { sourceRef: 'refs/heads/improvement/../main' }, { sourceRef: 'refs/heads/fix/' },
        { sourceRef: 'refs/heads/unknown/change' }, { sourceRef: 'refs/heads/fix/change;echo' },
        { sourceTriggerId: 'ef5a2981-95be-4f4d-af91-f997fde73356' }, { sourceTriggerId: 'd71109da-8350-4f2f-a3be-2053bb6ccd45' },
        { deploymentTriggerName: 'main-push-mickeyf-com' }, { unexpected: 'value' },
    ]) assert.throws(() => validateFrozenPins({ ...pins, ...change }));
});

const invalidSessionVersions = [undefined, null, 2, true, '', '0', '02', '-1', '1.5',
    'latest', 'current', ' 2', '2 ', '2\n', '2\r\n', '2\u00a0', '2;echo unsafe'];

test('session-secret version must be supplied as an exact positive decimal string', () => {
    for (const version of ['1', '2', '17']) {
        assert.equal(validateSessionSecretVersion(version), version);
        assert.equal(validateFrozenPins({ ...pins, sessionSecretVersion: version }).sessionSecretVersion, version);
    }
    for (const sessionSecretVersion of invalidSessionVersions) {
        assert.throws(() => validateSessionSecretVersion(sessionSecretVersion));
        assert.throws(() => renderFrozenBackendDeployConfig({ ...input, pins: { ...pins, sessionSecretVersion } }));
    }
    const { sessionSecretVersion, ...missingVersion } = pins;
    assert.throws(() => validateFrozenPins(missingVersion));
});

test('one reviewed version pins deployment, runtime verification, approval and resolved steps digest', () => {
    const alternatePins = { ...pins, sessionSecretVersion: '17' };
    const alternateConfig = renderFrozenBackendDeployConfig({ ...input, pins: alternatePins });
    const alternateApproval = frozenDeploymentApproval(alternatePins);
    assert.equal(alternateApproval, `freeze-zero-traffic:${pins.sourceCommit}:${pins.sourceBuildId}:${pins.imageDigest}:session-secret:17`);
    assert.match(alternateConfig.steps[5].args[1], /DB_PASS=DB_PASS:1,SESSION_SECRET=SESSION_SECRET:17/u);
    assert.match(alternateConfig.steps[6].args[1], /"DB_PASS": "1",\s+"SESSION_SECRET": "17"/u);
    assert.doesNotMatch(alternateConfig.steps[5].args[1], /SESSION_SECRET=SESSION_SECRET:2/u);
    assert.doesNotMatch(alternateConfig.steps[6].args[1], /"SESSION_SECRET": "2"/u);
    const alternateSteps = resolveFrozenDeploymentSteps(alternateConfig.steps, {
        buildId, deploymentTriggerId, approval: alternateApproval,
    });
    assert.notEqual(frozenDeploymentStepsSha256(alternateSteps), frozenDeploymentStepsSha256(resolved));
    for (const invalidApproval of [approval.replace(':session-secret:2', ''), ...invalidSessionVersions.map(
        version => approval.replace(':session-secret:2', `:session-secret:${version}`),
    ).filter(value => value !== approval)]) {
        assert.throws(() => resolveFrozenDeploymentSteps(config.steps, { buildId, deploymentTriggerId, approval: invalidApproval }));
    }
});

test('Python preflight rejects missing, malformed or differently approved versions before cloud access', () => {
    const result = python(`
from io import StringIO
from unittest.mock import patch
class CloudReached(Exception): pass
calls = []
def cloud_command(args):
    calls.append(args)
    raise CloudReached()
def run(candidate, approval):
    calls.clear()
    with patch.dict(namespace, {"open": lambda *args, **kwargs: StringIO(json.dumps(candidate)), "command": cloud_command}), \\
            patch.object(sys, "argv", ["preflight", "unused", payload["buildId"], payload["triggerId"], approval, "initial"]):
        try:
            namespace["main"]()
        except SystemExit:
            assert not calls, "invalid version/approval reached cloud access"
            return False
        except CloudReached:
            assert len(calls) == 1
            return True
    raise AssertionError("preflight unexpectedly finished")
base = payload["pins"]
for value in payload["invalidVersions"]:
    assert not run(dict(base, sessionSecretVersion=value), payload["approval"])
missing = {key: value for key, value in base.items() if key != "sessionSecretVersion"}
assert not run(missing, payload["approval"])
assert not run(base, payload["approval"].replace(":session-secret:2", ""))
alternate = dict(base, sessionSecretVersion="17")
assert not run(alternate, payload["approval"])
assert run(base, payload["approval"])
assert run(alternate, payload["approval"].replace(":session-secret:2", ":session-secret:17"))
`, { pins: validateFrozenPins(pins), approval, buildId, triggerId: deploymentTriggerId,
        invalidVersions: invalidSessionVersions });
    assert.equal(result.status, 0, result.stderr);
});

test('source-less generated package requires approval and contains no traffic promotion, expiry, notification or secrets payload', () => {
    assert.equal(config.steps.length, 8);
    assert.equal(config.serviceAccount, 'projects/noted-reef-387021/serviceAccounts/mickeyf-backend-deploy@noted-reef-387021.iam.gserviceaccount.com');
    assert.deepEqual(config.substitutions, { _DEPLOY_TRIGGER_ID: 'INVALID', _APPROVAL: 'INVALID' });
    assert.equal(config.source, undefined);
    assert.equal(config.images, undefined);
    assert.equal(config.artifacts, undefined);
    assert.equal(config.availableSecrets, undefined);
    const scripts = config.steps.flatMap((step) => step.args).join('\n');
    assert.doesNotMatch(scripts, /SLACK|candidate-tag-expiry|run services update-traffic|method="PATCH"/u);
    assert.doesNotMatch(scripts, /SUBMISSIONS_ENABLED=true/u);
    assert.match(scripts, /--no-traffic --tag=/u);
    assert.match(scripts, /P4_VEGA_SCORE_SUBMISSIONS_ENABLED=false,THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=false/u);
    assert.match(scripts, /DB_PASS=DB_PASS:1,SESSION_SECRET=SESSION_SECRET:2/u);
    assert.match(scripts, /new revision received production traffic/u);
    assert.match(scripts, /before-deploy/u);
    assert.match(scripts, /after-deploy/u);
    assert.match(scripts, /Frozen revision already exists/u);
    assert.ok(config.steps.every((step) => step.args.every((arg) => arg.length <= 10_000)));
});

test('scan policy remains strict and anonymous HTTP requires both frozen gates', () => {
    const discovery = config.steps[2].args[1];
    const severity = config.steps[3].args[1];
    assert.match(discovery, /FINISHED_SUCCESS/u);
    assert.match(discovery, /\{"OS", "NPM", "SECRET"\}/u);
    assert.match(severity, /if counts\["HIGH"\] or counts\["CRITICAL"\]:/u);
    assert.match(config.steps[5].args[1], /blocking_count != 0/u);
    const smoke = config.steps[7].args.slice(3).join('');
    assert.match(smoke, /"\/api\/leaderboards\/three-bosses\/run-tickets", 403/u);
    assert.match(smoke, /"\/api\/leaderboards\/three-bosses\/runs", 403/u);
    assert.match(smoke, /"\/api\/users", 503, \{"type": "submit_score"/u);
    assert.match(smoke, /SUBMISSION_DISABLED/u);
    assert.match(smoke, /SUBMISSIONS_FROZEN/u);
    assert.match(smoke, /"submissionState": "disabled"/u);
    assert.match(smoke, /no_store\(anonymous_p4_submission_headers\)/u);
});

test('resolved deployment digest binds the reviewed steps plus exact dispatch without recursive substitution', () => {
    assert.equal(frozenDeploymentStepsSha256(resolved).length, 64);
    assert.notEqual(frozenDeploymentStepsSha256(resolved), frozenDeploymentStepsSha256(config.steps));
    assert.notEqual(frozenDeploymentStepsSha256(resolved), frozenDeploymentStepsSha256(resolveFrozenDeploymentSteps(config.steps, {
        buildId: '423e4567-e89b-42d3-a456-426614174000', deploymentTriggerId, approval,
    })));
    const source = resolved[5].args[1];
    assert.match(source, /\$\(python3/u);
    assert.doesNotMatch(source, /\$\$|\$\{BUILD_ID\}|\$\{_APPROVAL\}/u);
    assert.ok(source.includes(approval));
    assert.throws(() => resolveFrozenDeploymentSteps(config.steps, { buildId, deploymentTriggerId, approval: 'INVALID' }));
    assert.equal(frozenDeploymentStepsSha256([{ b: 1, a: 2 }]), frozenDeploymentStepsSha256([{ a: 2, b: 1 }]));
    const observed = resolved.map((step) => ({ ...step, status: 'SUCCESS', timing: {}, pullTiming: {}, exitCode: 0 }));
    assert.equal(frozenDeploymentStepsSha256(resolved), deploymentStepsFingerprint(observed));
});

test('all resolved Bash programs pass syntax checking without execution', () => {
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    for (const step of resolved.filter((item) => item.entrypoint === 'bash')) {
        const result = spawnSync(bash, ['--noprofile', '--norc', '-n'], {
            input: step.args[1], encoding: 'utf8', timeout: 10_000,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, `${step.id}: ${result.stderr}`);
    }
});

test('all embedded Python programs compile after Cloud Build interpolation', () => {
    const programs = [resolved[0].args[1], resolved[4].args[1], resolved[7].args.slice(3).join('')];
    for (const step of resolved.slice(2, 7)) {
        for (const match of step.args.join('\n').matchAll(/<<'PY'\n([\s\S]*?)\nPY/gu)) programs.push(match[1]);
    }
    const result = python('for source in payload["programs"]: compile(source,"generated.py","exec")\nprint(len(payload["programs"]))', { programs });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Number(result.stdout.trim()) >= 8);
});

const enabledDeletion = {
    enabled: true, journalBucket: ACCOUNT_DELETION_JOURNAL_BUCKET, identityEpoch: ORIGINAL_ACCOUNT_IDENTITY_EPOCH,
};

test('deletion defaults off; enabling and intentional disabling are explicit source/image-bound configurations', () => {
    assert.deepEqual(accountDeletionEnvironment(), { ACCOUNT_DELETION_ENABLED: 'false' });
    assert.deepEqual(config.steps[4].env.filter(item => item.startsWith('ACCOUNT_')), [
        'ACCOUNT_DELETION_ENABLED=false', 'ACCOUNT_DELETION_JOURNAL_BUCKET=', 'ACCOUNT_IDENTITY_EPOCH=',
        'ACCOUNT_DELETION_APPROVAL=DISABLED',
    ]);
    assert.match(input.canonical, /_ACCOUNT_DELETION_ENABLED: 'false'/u);
    for (const settings of [null, {}, { enabled: 'true' }, { enabled: true },
        { ...enabledDeletion, journalBucket: 'other' }, { ...enabledDeletion, identityEpoch: '2026-09-13 00:15:39.954172' },
        { ...enabledDeletion, arbitrary: 'unsafe' }, { enabled: false, journalBucket: ACCOUNT_DELETION_JOURNAL_BUCKET }]) {
        assert.throws(() => renderFrozenBackendDeployConfig({ ...input, pins: { ...pins, accountDeletion: settings } }));
    }
    for (const settings of [enabledDeletion, { enabled: false }]) {
        const explicit = renderFrozenBackendDeployConfig({ ...input, pins: { ...pins, accountDeletion: settings } });
        assert.ok(explicit.steps[4].env.includes(`ACCOUNT_DELETION_APPROVAL=${settings.enabled ? 'enable' : 'disable'}-account-deletion:${pins.sourceCommit}:${pins.sourceBuildId}:${pins.imageDigest}`));
        assert.notEqual(frozenDeploymentStepsSha256(explicit.steps), frozenDeploymentStepsSha256(config.steps));
        assert.doesNotMatch(JSON.stringify(explicit), /\$\{_ACCOUNT_/u);
    }
});

test('Google defaults off; full signup/login requires exact client, deletion and source-bound explicit approval', () => {
    const disabled = { PROVIDER_AUTH_ENABLED: 'false', PROVIDER_GOOGLE_SIGNUP_ENABLED: 'false' };
    const enabled = { enabled: true, clientId: APPROVED_GOOGLE_WEB_CLIENT_ID };
    assert.deepEqual(googleSignInEnvironment(), disabled);
    assert.deepEqual(googleSignInEnvironment({ enabled: false }), disabled);
    assert.deepEqual(googleSignInEnvironment(enabled, enabledDeletion), {
        PROVIDER_AUTH_ENABLED: 'true', PROVIDER_GOOGLE_SIGNUP_ENABLED: 'true', GOOGLE_WEB_CLIENT_ID: APPROVED_GOOGLE_WEB_CLIENT_ID,
    });
    assert.deepEqual(config.steps[4].env.filter(item => !item.startsWith('ACCOUNT_')), [
        'PROVIDER_AUTH_ENABLED=false', 'PROVIDER_GOOGLE_SIGNUP_ENABLED=false', 'GOOGLE_WEB_CLIENT_ID=', 'GOOGLE_SIGN_IN_APPROVAL=DISABLED',
    ]);
    for (const settings of [null, {}, [], { enabled: 'true' }, { enabled: true },
        { enabled: true, clientId: `${APPROVED_GOOGLE_WEB_CLIENT_ID} ` }, { enabled: true, clientId: 'other.apps.googleusercontent.com' },
        { ...enabled, signup: false }, { ...enabled, appleClientId: 'com.mickeyf.app' }, { enabled: false, clientId: APPROVED_GOOGLE_WEB_CLIENT_ID }]) {
        assert.throws(() => renderFrozenBackendDeployConfig({ ...input, pins: { ...pins, googleSignIn: settings, accountDeletion: enabledDeletion } }));
    }
    for (const accountDeletion of [undefined, { enabled: false }, { ...enabledDeletion, journalBucket: 'other' }]) {
        assert.throws(() => renderFrozenBackendDeployConfig({ ...input, pins: { ...pins, googleSignIn: enabled, accountDeletion } }));
    }
    for (const settings of [enabled, { enabled: false }]) {
        const rendered = renderFrozenBackendDeployConfig({ ...input, pins: { ...pins, accountDeletion: enabledDeletion, googleSignIn: settings } });
        assert.ok(rendered.steps[4].env.includes(`GOOGLE_SIGN_IN_APPROVAL=${settings.enabled ? 'enable' : 'disable'}-google-sign-in:${pins.sourceCommit}:${pins.sourceBuildId}:${pins.imageDigest}`));
        assert.notEqual(frozenDeploymentStepsSha256(rendered.steps), frozenDeploymentStepsSha256(config.steps));
        assert.doesNotMatch(JSON.stringify(rendered), /\$\{_(PROVIDER|GOOGLE)/u);
    }
    // The validated artifact feeds both deployment and exact revision verification.
    assert.match(config.steps[5].args[1], /--set-env-vars=.*\$\$DELETION_ENV/u);
    assert.match(config.steps[6].args[1], /plain\.update\(json\.load\(handle\)\["environment"\]\)/u);
    for (const declaration of ["_PROVIDER_AUTH_ENABLED: 'false'", "_PROVIDER_GOOGLE_SIGNUP_ENABLED: 'false'",
        "_GOOGLE_WEB_CLIENT_ID: ''", "_GOOGLE_SIGN_IN_APPROVAL: 'DISABLED'"]) assert.ok(input.canonical.includes(declaration));
});

test('canonical Google policy rejects partial activation, client drift and approval/deletion mismatches', () => {
    const code = String.raw`
policy = {"__name__": "reviewed_google_contract"}
exec(compile(payload["policy"], "google-contract.py", "exec"), policy)
environment = policy["google_environment"]
state = {"commit":payload["pins"]["sourceCommit"], "build_id":payload["pins"]["sourceBuildId"], "digest":payload["pins"]["imageDigest"]}
suffix = f"{state['commit']}:{state['build_id']}:{state['digest']}"
off = {"PROVIDER_AUTH_ENABLED":"false", "PROVIDER_GOOGLE_SIGNUP_ENABLED":"false", "GOOGLE_WEB_CLIENT_ID":"", "GOOGLE_SIGN_IN_APPROVAL":"DISABLED"}
on = {"PROVIDER_AUTH_ENABLED":"true", "PROVIDER_GOOGLE_SIGNUP_ENABLED":"true", "GOOGLE_WEB_CLIENT_ID":policy["GOOGLE_CLIENT"], "GOOGLE_SIGN_IN_APPROVAL":"enable-google-sign-in:"+suffix}
deletion = {"ACCOUNT_DELETION_ENABLED":"true"}
assert environment(off,state,{}) == ({"PROVIDER_AUTH_ENABLED":"false", "PROVIDER_GOOGLE_SIGNUP_ENABLED":"false"},False)
assert environment(on,state,deletion) == ({key:on[key] for key in policy["GOOGLE_KEYS"]},False)
assert environment({**off,"GOOGLE_SIGN_IN_APPROVAL":"disable-google-sign-in:"+suffix},state,{})[1]
def fails(call):
    try: call()
    except SystemExit: return
    raise AssertionError("unsafe Google deployment configuration accepted")
for key,value in [("PROVIDER_AUTH_ENABLED","TRUE"),("PROVIDER_GOOGLE_SIGNUP_ENABLED","false"),
                  ("GOOGLE_WEB_CLIENT_ID","other.apps.googleusercontent.com"),("GOOGLE_WEB_CLIENT_ID",policy["GOOGLE_CLIENT"]+" "),
                  ("GOOGLE_SIGN_IN_APPROVAL","DISABLED"),("GOOGLE_SIGN_IN_APPROVAL","enable-google-sign-in:other")]:
    fails(lambda:environment({**on,key:value},state,deletion))
for key in state: fails(lambda:environment(on,{**state,key:"different"},deletion))
for wrong in [{},{"ACCOUNT_DELETION_ENABLED":"false"}]: fails(lambda:environment(on,state,wrong))
for changed in [{**off,"GOOGLE_WEB_CLIENT_ID":policy["GOOGLE_CLIENT"]},{**off,"PROVIDER_GOOGLE_SIGNUP_ENABLED":"true"}]:
    fails(lambda:environment(changed,state,deletion))
print("Google deployment configuration fixtures passed")
`;
    const result = python(code, { policy: resolved[4].args[1], pins });
    assert.equal(result.status, 0, result.stderr);
});

test('canonical Google policy protects template, serving and tagged revisions from implicit disable and unknown provider states', () => {
    const code = String.raw`
from copy import deepcopy
policy = {"__name__": "reviewed_google_contract"}
exec(compile(payload["policy"], "google-contract.py", "exec"), policy)
previous = policy["check_previous_state"]
off = {"ACCOUNT_DELETION_ENABLED":"true","ACCOUNT_DELETION_JOURNAL_BUCKET":policy["BUCKET"],"ACCOUNT_IDENTITY_EPOCH":policy["EPOCH"],
       "PROVIDER_AUTH_ENABLED":"false","PROVIDER_GOOGLE_SIGNUP_ENABLED":"false"}
on = {**off,"PROVIDER_AUTH_ENABLED":"true","PROVIDER_GOOGLE_SIGNUP_ENABLED":"true","GOOGLE_WEB_CLIENT_ID":policy["GOOGLE_CLIENT"]}
def spec(values): return {"containers":[{"env":[{"name":key,"value":value} for key,value in values.items()]}]}
traffic = [{"revisionName":"current","percent":100},{"revisionName":"tagged","tag":"old","percent":0}]
service = {"metadata":{"uid":"service-uid","generation":2},"spec":{"template":{"spec":spec(off)},"traffic":deepcopy(traffic)},
           "status":{"observedGeneration":2,"conditions":[{"type":"Ready","status":"True"}],"traffic":deepcopy(traffic)}}
revisions = [{"metadata":{"name":name},"spec":spec(off)} for name in ["current","tagged"]]
def fails(call):
    try: call()
    except SystemExit: return
    raise AssertionError("unsafe active Google state accepted")
for where in ["template","current","tagged"]:
    current=deepcopy(service); inventory=deepcopy(revisions)
    if where=="template": current["spec"]["template"]["spec"]=spec(on)
    else: inventory[0 if where=="current" else 1]["spec"]=spec(on)
    fails(lambda:previous(current,inventory,off,False))
    previous(current,inventory,on,False)
    previous(current,inventory,off,False,True)
for change in [{"PROVIDER_AUTH_ENABLED":"TRUE"},{"PROVIDER_GOOGLE_SIGNUP_ENABLED":"false"},
               {"GOOGLE_WEB_CLIENT_ID":"other.apps.googleusercontent.com"},{"GOOGLE_IOS_CLIENT_ID":"ios"},
               {"APPLE_IOS_BUNDLE_ID":"com.mickeyf.app"},{"APPLE_WEB_SERVICES_ID":"apple"},
               {"APPLE_CLIENT_ID":"other"},{"GOOGLE_FUTURE_SETTING":"unreviewed"},
               {"PROVIDER_UNKNOWN_ENABLED":"true"},{"ACCOUNT_DELETION_ENABLED":"false"}]:
    changed=deepcopy(service); changed["spec"]["template"]["spec"]=spec({**on,**change})
    fails(lambda:previous(changed,revisions,off,True,True))
for bad_env in [spec(on)["containers"][0]["env"]+[{"name":"GOOGLE_WEB_CLIENT_ID","value":policy["GOOGLE_CLIENT"]}],
                spec(off)["containers"][0]["env"]+[{"name":"GOOGLE_WEB_CLIENT_ID","value":policy["GOOGLE_CLIENT"]}],
                [{"name":"PROVIDER_AUTH_ENABLED","valueFrom":{"secretKeyRef":{"name":"other","key":"1"}}}]]:
    changed=deepcopy(service); changed["spec"]["template"]["spec"]={"containers":[{"env":bad_env}]}
    fails(lambda:previous(changed,revisions,off,True,True))
print("Google active-state fixtures passed")
`;
    const result = python(code, { policy: resolved[4].args[1] });
    assert.equal(result.status, 0, result.stderr);
});

test('canonical deletion policy rejects unapproved pins and silent live/tagged downgrades but permits approved rollback', () => {
    const code = String.raw`
from copy import deepcopy
policy = {"__name__": "reviewed_deletion_contract"}
exec(compile(payload["policy"], "deletion-contract.py", "exec"), policy)
environment = policy["deployment_environment"]
previous = policy["check_previous_state"]
state = {"commit":payload["pins"]["sourceCommit"], "build_id":payload["pins"]["sourceBuildId"], "digest":payload["pins"]["imageDigest"]}
base = {"ACCOUNT_DELETION_ENABLED":"false", "ACCOUNT_DELETION_JOURNAL_BUCKET":"", "ACCOUNT_IDENTITY_EPOCH":"", "ACCOUNT_DELETION_APPROVAL":"DISABLED"}
suffix = f"{state['commit']}:{state['build_id']}:{state['digest']}"
enabled = {"ACCOUNT_DELETION_ENABLED":"true", "ACCOUNT_DELETION_JOURNAL_BUCKET":policy["BUCKET"],
           "ACCOUNT_IDENTITY_EPOCH":policy["EPOCH"], "ACCOUNT_DELETION_APPROVAL":"enable-account-deletion:"+suffix}
off, explicit = environment(base, state)
assert off == {"ACCOUNT_DELETION_ENABLED":"false"} and not explicit
on, _ = environment(enabled, state)
assert len(on) == 3
def fails(call):
    try: call()
    except SystemExit: return
    raise AssertionError("unsafe deletion configuration accepted")
for key, value in [("ACCOUNT_DELETION_ENABLED","TRUE"), ("ACCOUNT_DELETION_JOURNAL_BUCKET","other"),
                   ("ACCOUNT_IDENTITY_EPOCH","2026-09-13 00:15:39.954172"), ("ACCOUNT_IDENTITY_EPOCH","'; echo injected"),
                   ("ACCOUNT_DELETION_APPROVAL","DISABLED"), ("ACCOUNT_DELETION_APPROVAL","enable-account-deletion:other")]:
    fails(lambda: environment({**enabled, key:value}, state))
fails(lambda: environment({**base,"ACCOUNT_IDENTITY_EPOCH":policy["EPOCH"]}, state))
for key in state:
    fails(lambda: environment(enabled, {**state,key:"different"}))
def spec(values): return {"containers":[{"env":[{"name":key,"value":value} for key,value in values.items()]}]}
traffic = [{"revisionName":"current","percent":100}, {"revisionName":"older-enabled","tag":"old","percent":0}]
service = {"metadata":{"uid":"service-uid","generation":2}, "spec":{"template":{"spec":spec(off)},"traffic":deepcopy(traffic)},
           "status":{"observedGeneration":2,"conditions":[{"type":"Ready","status":"True"}],"traffic":deepcopy(traffic)}}
revisions = [{"metadata":{"name":"current"},"spec":spec(off)}, {"metadata":{"name":"older-enabled"},"spec":spec(on)}]
fails(lambda: previous(service,revisions,off,False))
assert previous(service,revisions,on,False) == {"uid":"service-uid","generation":"2"}
rollback, explicit = environment({**base,"ACCOUNT_DELETION_APPROVAL":"disable-account-deletion:"+suffix},state)
assert explicit
previous(service,revisions,rollback,explicit)
fails(lambda: previous(service,revisions[:1],rollback,explicit))
changed=deepcopy(service); changed["status"]["observedGeneration"]=1
fails(lambda: previous(changed,revisions,rollback,explicit))
changed=deepcopy(service); changed["spec"]["template"]["spec"]=spec(on)
fails(lambda: previous(changed,[{**r,"spec":spec(off)} for r in revisions],off,False))
changed=deepcopy(service); changed["spec"]["traffic"][0]={"latestRevision":True,"percent":100}
fails(lambda: previous(changed,revisions,rollback,explicit))
changed["status"]["latestReadyRevisionName"]="current"
previous(changed,revisions,rollback,explicit)
print("deletion policy fixtures passed")
`;
    const result = python(code, { policy: resolved[4].args[1], pins });
    assert.equal(result.status, 0, result.stderr);
});

const fixtureCode = String.raw`
from copy import deepcopy
now = datetime(2026, 9, 8, 18, 0, tzinfo=timezone.utc)
pins = payload["pins"]
tag = f"{IMAGE}:{pins['sourceCommit']}"
source = {"url": REPOSITORY, "revision": pins["sourceCommit"]}
commit = pins["sourceCommit"]
build = {"id":pins["sourceBuildId"],"name":f"projects/{NUMBER}/locations/global/builds/{pins['sourceBuildId']}",
    "projectId":PROJECT,"status":"SUCCESS","buildTriggerId":pins["sourceTriggerId"],"serviceAccount":BUILD_SA,
    "approval":{"config":{"approvalRequired":True},"state":"APPROVED","result":{"decision":"APPROVED"}},
    "createTime":"2026-09-08T17:00:00Z","startTime":"2026-09-08T17:01:00Z","finishTime":"2026-09-08T17:05:00Z",
    "source":{"gitSource":source},"sourceProvenance":{"resolvedGitSource":source},"substitutions":substitutions(pins),
    "options":{"requestedVerifyOption":"VERIFIED","logging":"CLOUD_LOGGING_ONLY"},"images":[tag],"artifacts":{"images":[tag]},
    "results":{"images":[{"name":tag,"digest":pins["imageDigest"]}]},"steps":[
      {"id":"Require exact source commit","name":BUILDER,"entrypoint":"sh","status":"SUCCESS","args":["-ceu",
      f"commit='{commit}'\n" + 'test "' + '$' + '{#commit}" -eq 40\n' + 'case "$commit" in\n'
      + "  *[!0-9a-f]*) printf 'COMMIT_SHA must be 40 lowercase hexadecimal characters.\\n' >&2; exit 1 ;;\n" + "esac"]},
      {"id":"Build backend candidate image","name":BUILDER,"dir":".","status":"SUCCESS","args":["build","-t",tag,"."]}]}
trigger = {"id":pins["sourceTriggerId"],"resourceName":f"projects/{PROJECT}/locations/global/triggers/{pins['sourceTriggerId']}",
    "name":pins["sourceTriggerName"],"serviceAccount":BUILD_SA,"approvalConfig":{"approvalRequired":True},
    "sourceToBuild":{"ref":pins["sourceRef"],"repoType":"GITHUB","uri":REPOSITORY.removesuffix(".git")},
    "gitFileSource":{"path":"cloudbuild.candidate.yaml","repoType":"GITHUB","revision":pins["sourceRef"],"uri":REPOSITORY.removesuffix(".git")}}

def fails(call):
    try: call()
    except SystemExit: return
    raise AssertionError("unsafe fixture was accepted")
`;

test('source preflight accepts exact image-only contract and rejects source/approval/image/step/trigger drift', () => {
    const code = fixtureCode + String.raw`
verify_source(build,trigger,pins,now)
for path, value in [
    (("source","gitSource","revision"),"main"), (("sourceProvenance","resolvedGitSource","revision"),"b"*40),
    (("approval","state"),"PENDING"), (("serviceAccount",),DEPLOY_SA), (("finishTime",),"2026-09-08T12:00:00Z"),
    (("options","requestedVerifyOption"),"NOT_VERIFIED"), (("results","images",0,"digest"),"sha256:"+"c"*64),
    (("options","env"),["DOCKER_HOST=other"]), (("options","pool"),{"name":"untrusted-worker"}),
    (("options","volumes"),[{"name":"unsafe","path":"/workspace"}]), (("options","automapSubstitutions"),True),
    (("steps",1,"env"),["EVIL=1"]), (("steps",1,"entrypoint"),"bash"), (("steps",1,"exitCode"),1),
    (("artifacts","objects"),{"location":"bucket"}), (("substitutions","EXTRA"),"unsafe"),
]:
    changed=deepcopy(build); cursor=changed
    for key in path[:-1]: cursor=cursor[key]
    cursor[path[-1]]=value
    fails(lambda: verify_source(changed,trigger,pins,now))
for change in [{"build":{}},{"disabled":True},{"approvalConfig":{"approvalRequired":False}},{"github":{}},{"sourceToBuild":{}}]:
    fails(lambda: verify_source(build,{**trigger,**change},pins,now))
print("source fixtures passed")
`;
    const result = python(code, { pins: validateFrozenPins(pins) });
    assert.equal(result.status, 0, result.stderr);
});

test('stable explicit traffic rejects latest, unresolved state, duplicate tags and incomplete allocations', () => {
    const code = String.raw`
from copy import deepcopy
service={"metadata":{"name":SERVICE,"generation":10},"spec":{"traffic":[{"revisionName":"mickeyf-org-old","percent":100}]},
 "status":{"observedGeneration":10,"conditions":[{"type":"Ready","status":"True"}],"traffic":[{"revisionName":"mickeyf-org-old","percent":100}]}}
snapshot=stable_service(service)
assert snapshot==json.loads(json.dumps(snapshot))
cases=[]
changed=deepcopy(service); changed["spec"]["traffic"][0]["latestRevision"]=True; cases.append(changed)
changed=deepcopy(service); changed["status"]["observedGeneration"]=9; cases.append(changed)
changed=deepcopy(service); changed["status"]["traffic"][0]["revisionName"]="mickeyf-org-other"; cases.append(changed)
changed=deepcopy(service); changed["spec"]["traffic"][0]["percent"]=99; cases.append(changed)
changed=deepcopy(service); changed["spec"]["traffic"][0]["percent"]=True; cases.append(changed)
for changed in cases:
    try: stable_service(changed)
    except SystemExit: continue
    raise AssertionError("unsafe traffic accepted")
print("traffic fixtures passed")
`;
    const result = python(code, {});
    assert.equal(result.status, 0, result.stderr);
});

test('exclusion rejects active canonical triggers, other builds, unknown enabled triggers and unsafe deploy identity', () => {
    const code = fixtureCode + String.raw`
bid=payload["buildId"]; tid=payload["deploymentTriggerId"]
stage_a={"id":STAGE_A,"name":"main-push-mickeyf-com","resourceName":f"projects/{PROJECT}/locations/global/triggers/{STAGE_A}","disabled":True}
stage_b={"id":pins["canonicalDeployTriggerId"],"name":pins["canonicalDeployTriggerName"],"resourceName":f"projects/{PROJECT}/locations/global/triggers/{pins['canonicalDeployTriggerId']}","disabled":True}
deploy={"id":bid,"name":f"projects/{NUMBER}/locations/global/builds/{bid}","projectId":PROJECT,"buildTriggerId":tid,
 "status":"WORKING","serviceAccount":DEPLOY_SA,"approval":build["approval"],"options":{"logging":"CLOUD_LOGGING_ONLY"},"timeout":"2400s"}
dt={"id":tid,"name":pins["deploymentTriggerName"],"resourceName":f"projects/{PROJECT}/locations/global/triggers/{tid}",
 "approvalConfig":{"approvalRequired":True},"serviceAccount":DEPLOY_SA,"build":{"steps":[],"options":{"logging":"CLOUD_LOGGING_ONLY"},"timeout":"2400s"}}
triggers=[stage_a,stage_b,trigger,dt]
def check(a=stage_a,b=stage_b,active=[{"id":bid}],d=deploy,t=dt,ts=triggers):
    verify_exclusion(a,b,active,d,t,ts,pins,bid,tid)
check()
fails(lambda:check(a={**stage_a,"disabled":False}))
fails(lambda:check(b={**stage_b,"disabled":False}))
fails(lambda:check(active=[{"id":bid},{"id":"other"}]))
fails(lambda:check(ts=triggers+[{"id":"unknown","disabled":False}]))
fails(lambda:check(d={**deploy,"serviceAccount":BUILD_SA}))
fails(lambda:check(d={**deploy,"source":{"gitSource":source}}))
fails(lambda:check(d={**deploy,"options":{"logging":"CLOUD_LOGGING_ONLY","env":["UNSAFE=1"]}}))
fails(lambda:check(t={**dt,"sourceToBuild":{}}))
fails(lambda:check(t={**dt,"build":{"options":{"logging":"CLOUD_LOGGING_ONLY","pool":{"name":"foreign"}}}}))
fails(lambda:check(t={**dt,"approvalConfig":{"approvalRequired":False}}))
print("exclusion fixtures passed")
`;
    const result = python(code, { pins: validateFrozenPins(pins), buildId, deploymentTriggerId });
    assert.equal(result.status, 0, result.stderr);
});

test('provenance binds the authenticated registry envelope to exact image/build/source/trigger', () => {
    const code = fixtureCode + String.raw`
bid=pins["sourceBuildId"]; digest=pins["imageDigest"]; target=f"{IMAGE}@{digest}"
system={key:value for key,value in substitutions(pins).items() if not key.startswith("_")}
system.update({"BUILD_ID":bid,"LOCATION":REGION,"PROJECT_NUMBER":NUMBER,"SERVICE_ACCOUNT":BUILD_SA,"SERVICE_ACCOUNT_EMAIL":BUILD_SA.split("/")[-1]})
statement={"_type":"https://in-toto.io/Statement/v1","predicateType":"https://slsa.dev/provenance/v1",
 "subject":[{"digest":{"sha256":digest.removeprefix("sha256:")},"name":f"https://{tag}"}],
 "predicate":{"buildDefinition":{"buildType":"https://cloud.google.com/build/gcb-buildtypes/google-worker/v1",
 "externalParameters":{"substitutions":{}},"internalParameters":{"systemSubstitutions":system,"triggerUri":f"projects/{NUMBER}/locations/global/triggers/{pins['sourceTriggerId']}"},
 "resolvedDependencies":[{"digest":{"gitCommit":pins["sourceCommit"]},"uri":f"git+{REPOSITORY}"},
 {"digest":{"sha256":BUILDER.split("sha256:")[1]},"uri":f"{BUILDER}@sha256:{BUILDER.split('sha256:')[1]}"}]},
 "runDetails":{"builder":{"id":"https://cloudbuild.googleapis.com/GoogleHostedWorker"},"metadata":{"invocationId":f"https://cloudbuild.googleapis.com/v1/projects/{PROJECT}/locations/global/builds/{bid}"}}}}
occurrence={"kind":"BUILD","resourceUri":f"https://{target}","noteName":f"projects/verified-builder/notes/intoto_slsa_v1_{bid}",
 "build":{"inTotoSlsaProvenanceV1":statement},"envelope":{"payloadType":"application/vnd.in-toto+json","payload":base64.b64encode(json.dumps(statement).encode()).decode(),
 "signatures":[{"keyid":"projects/verified-builder/locations/global/keyRings/attestor/cryptoKeys/google-hosted-worker/cryptoKeyVersions/1","sig":base64.urlsafe_b64encode(bytes([251,255])*36).decode()}]}}
provenance={"image_summary":{"digest":digest,"fully_qualified_digest":target,"registry":"us-central1-docker.pkg.dev","repository":"cloud-run-source-deploy","slsa_build_level":3},
 "provenance_summary":{"provenance":[occurrence]}}
verify_provenance(provenance,pins)
for path,value in [(("image_summary","digest"),"sha256:"+"d"*64),
 (("provenance_summary","provenance",0,"envelope","payload"),base64.b64encode(b"{}").decode()),
 (("provenance_summary","provenance",0,"envelope","signatures",0,"keyid"),"wrong"),
 (("provenance_summary","provenance",0,"envelope","signatures",0,"sig"),"bad!signature"),
 (("provenance_summary","provenance",0,"noteName"),"wrong")]:
    changed=deepcopy(provenance); cursor=changed
    for key in path[:-1]:cursor=cursor[key]
    cursor[path[-1]]=value
    fails(lambda:verify_provenance(changed,pins))
for dependencies in [
 [{"digest":{"gitCommit":"c"*40},"uri":f"git+{REPOSITORY}"}, statement["predicate"]["buildDefinition"]["resolvedDependencies"][1]],
 statement["predicate"]["buildDefinition"]["resolvedDependencies"]+[{"uri":"unreviewed","digest":{"sha256":"d"*64}}],
 [statement["predicate"]["buildDefinition"]["resolvedDependencies"][1]],
 [statement["predicate"]["buildDefinition"]["resolvedDependencies"][0], {"uri":BUILDER+"-spoof","digest":{"sha256":BUILDER.split("sha256:")[1]}}],
]:
    changed=deepcopy(provenance)
    item=changed["provenance_summary"]["provenance"][0]
    item["build"]["inTotoSlsaProvenanceV1"]["predicate"]["buildDefinition"]["resolvedDependencies"]=dependencies
    item["envelope"]["payload"]=base64.b64encode(json.dumps(item["build"]["inTotoSlsaProvenanceV1"]).encode()).decode()
    fails(lambda:verify_provenance(changed,pins))
print("provenance fixtures passed")
`;
    const result = python(code, { pins: validateFrozenPins(pins) });
    assert.equal(result.status, 0, result.stderr);
});
