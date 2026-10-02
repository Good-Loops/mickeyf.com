import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { frozenDeploymentApproval, frozenDeploymentStepsSha256, renderFrozenBackendDeployConfig,
    renderSessionBackendDeployConfig, resolveFrozenDeploymentSteps, resolveSessionDeploymentSteps,
    sessionDeploymentApproval, validateFrozenPins, validateSessionPins } from './render-frozen-backend-deploy.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const pins = {
    sourceBuildId: '123e4567-e89b-42d3-a456-426614174000', sourceCommit: 'a'.repeat(40),
    imageDigest: `sha256:${'b'.repeat(64)}`, sourceTriggerId: '648fadca-3cd1-4b57-9d35-0f62a1468443',
    sourceTriggerName: 'session-image-candidate', sourceRef: 'refs/heads/improvement/clean-code-sweep',
    deploymentTriggerName: 'session-backend-candidate', previousSessionSecretVersion: '2', sessionSecretVersion: '17',
};
const input = { canonical: read('../cloudbuild.deploy.yaml'), candidate: read('../cloudbuild.candidate.yaml'),
    preflight: read('./render-frozen-backend-deploy.preflight.py'), pins };
const config = renderSessionBackendDeployConfig(input);
const preflight = Buffer.from(config.steps[0].args.slice(4).join(''), 'base64').toString('utf8');
const dispatch = { buildId: '223e4567-e89b-42d3-a456-426614174000',
    deploymentTriggerId: '323e4567-e89b-42d3-a456-426614174000', approval: sessionDeploymentApproval(pins) };
const resolved = resolveSessionDeploymentSteps(config.steps, dispatch);

function python(code, payload = {}) {
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c',
        'import json, sys\npayload=json.load(sys.stdin)\nnamespace={"__name__":"reviewed_session_preflight"}\n'
        + 'exec(compile(payload["source"],"session-preflight.py","exec"),namespace)\nglobals().update(namespace)\n' + code], {
        input: JSON.stringify({ source: preflight, pins: validateSessionPins(pins), ...payload }),
        encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}

test('session pins require a separate trigger and a newer explicit secret; frozen inputs remain separate', () => {
    assert.equal(validateSessionPins(pins).previousSessionSecretVersion, '2');
    assert.throws(() => validateFrozenPins(pins));
    for (const change of [
        { previousSessionSecretVersion: undefined }, { previousSessionSecretVersion: 'latest' },
        { previousSessionSecretVersion: '02' }, { previousSessionSecretVersion: 2 },
        { previousSessionSecretVersion: '17' }, { previousSessionSecretVersion: '18' },
        { sessionSecretVersion: 'latest' }, { sessionSecretVersion: '2' },
        { deploymentTriggerName: 'frozen-backend-candidate' }, { deploymentTriggerName: 'main-push-mickeyf-com' },
        { sourceCommit: 'main' }, { imageDigest: 'latest' }, { sourceRef: 'refs/heads/main' },
        { sourceTriggerId: 'ef5a2981-95be-4f4d-af91-f997fde73356' }, { unexpected: true },
    ]) assert.throws(() => renderSessionBackendDeployConfig({ ...input, pins: { ...pins, ...change } }));
    assert.throws(() => renderSessionBackendDeployConfig({ ...input, canonical: input.canonical + '\n' }), /hash changed/u);
    assert.throws(() => renderSessionBackendDeployConfig({ ...input, candidate: input.candidate + '\n' }), /hash changed/u);
});

test('session package keeps enabled scoring, exact runtime pins and zero traffic without extra operations', () => {
    assert.equal(config.steps.length, 8);
    assert.deepEqual(config.substitutions, { _DEPLOY_TRIGGER_ID: 'INVALID', _APPROVAL: 'INVALID' });
    for (const key of ['source', 'images', 'artifacts', 'availableSecrets']) assert.equal(config[key], undefined);
    const scripts = config.steps.flatMap(step => step.args).join('\n');
    assert.doesNotMatch(scripts, /SLACK|run services update-traffic|method="PATCH"|SUBMISSIONS_ENABLED=false/u);
    assert.match(config.steps[5].args[1], /--no-traffic --tag=/u);
    assert.match(config.steps[5].args[1], /P4_VEGA_SCORE_SUBMISSIONS_ENABLED=true,THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=true/u);
    assert.match(config.steps[5].args[1], /SESSION_SECRET=SESSION_SECRET:17/u);
    assert.match(config.steps[6].args[1], /"SESSION_SECRET": "17"/u);
    assert.match(config.steps[6].args[1], /"P4_VEGA_SCORE_SUBMISSIONS_ENABLED": "true"/u);
    assert.match(config.steps[6].args[1], /"THREE_BOSSES_RUN_SUBMISSIONS_ENABLED": "true"/u);
    assert.match(config.steps[2].args[1], /FINISHED_SUCCESS/u);
    assert.match(config.steps[3].args[1], /if counts\["HIGH"\] or counts\["CRITICAL"\]:/u);
    assert.match(config.steps[5].args[1], /blocking_count != 0/u);
    assert.match(scripts, /before-deploy/u);
    assert.match(scripts, /after-deploy/u);
    assert.ok(config.steps[4].env.includes('PROVIDER_AUTH_ENABLED=false'));
    assert.ok(config.steps.every(step => step.args.every(arg => arg.length <= 10_000)));
    const { previousSessionSecretVersion, ...frozenPins } = pins;
    const frozen = renderFrozenBackendDeployConfig({ ...input, pins: { ...frozenPins, deploymentTriggerName: 'frozen-backend-example' } });
    assert.match(frozen.steps[5].args[1], /SUBMISSIONS_ENABLED=false/u);
    assert.notEqual(frozenDeploymentStepsSha256(frozen.steps), frozenDeploymentStepsSha256(config.steps));
});

test('session approval and receipt digest bind both versions and cannot reuse frozen approval', () => {
    assert.ok(dispatch.approval.endsWith(':previous-session-secret:2:session-secret:17'));
    assert.throws(() => resolveSessionDeploymentSteps(config.steps, { ...dispatch, approval: frozenDeploymentApproval(pins) }));
    assert.throws(() => resolveFrozenDeploymentSteps(config.steps, dispatch));
    for (const change of [{ previousSessionSecretVersion: '3' }, { sessionSecretVersion: '18' }]) {
        const changed = { ...pins, ...change };
        const changedConfig = renderSessionBackendDeployConfig({ ...input, pins: changed });
        assert.notEqual(sessionDeploymentApproval(changed), dispatch.approval);
        assert.notEqual(frozenDeploymentStepsSha256(changedConfig.steps), frozenDeploymentStepsSha256(config.steps));
    }
    assert.equal(createHash('sha256').update(preflight).digest('hex'), config.steps[0].args[2]);
    assert.match(preflight, /SESSION_CUTOVER = True/u);
});

test('session preflight rejects bad paths, stale secrets and cross-mode approvals before cloud access', () => {
    python(String.raw`
from io import StringIO
from unittest.mock import patch
class CloudReached(Exception): pass
def cloud(*args): raise CloudReached()
def run(pins, approval, path="/workspace/session-pins.json"):
    with patch.dict(namespace, {"open":lambda *args,**kwargs:StringIO(json.dumps(pins)), "command":cloud}), \
            patch.object(sys,"argv",["preflight",path,payload["dispatch"]["buildId"],payload["dispatch"]["deploymentTriggerId"],approval,"initial"]):
        try: namespace["main"]()
        except SystemExit: return False
        except CloudReached: return True
    raise AssertionError("unexpected preflight completion")
pins = payload["pins"]
approval = payload["dispatch"]["approval"]
assert run(pins, approval)
for path in ["/workspace/frozen-pins.json", "/etc/passwd", "/workspace/../etc/passwd", ""]:
    assert not run(pins, approval, path)
for value in [None, "latest", "0", "02", "17", "18", 2]:
    assert not run(dict(pins, previousSessionSecretVersion=value), approval)
assert not run({key:value for key,value in pins.items() if key != "previousSessionSecretVersion"}, approval)
assert not run(pins, approval.replace("previous-session-secret:2", "previous-session-secret:3"))
assert not run(pins, payload["frozenApproval"])
`, { dispatch, frozenApproval: frozenDeploymentApproval(pins) });
});

test('session preflight preserves one serving revision, its enabled scores and old secret across deployment', () => {
    python(String.raw`
from copy import deepcopy
from unittest.mock import patch
def spec(version):
    return {"containers":[{"env":[{"name":"SESSION_SECRET","valueFrom":{"secretKeyRef":{"name":"SESSION_SECRET","key":version}}},
        {"name":"P4_VEGA_SCORE_SUBMISSIONS_ENABLED","value":"true"},
        {"name":"THREE_BOSSES_RUN_SUBMISSIONS_ENABLED","value":"true"}]}]}
record = {"metadata":{"name":"mickeyf-org-previous"}, "spec":spec("2")}
service = {"spec":{"template":{"spec":spec("2")},"traffic":[{"revisionName":"mickeyf-org-previous","percent":100}]}}
calls=[]
def command(args):
    calls.append(args)
    assert args == ["run","revisions","describe","mickeyf-org-previous",f"--project={PROJECT}","--region=us-central1","--format=json"]
    return record
def rejects(candidate, phase="initial"):
    try: namespace["verify_session_cutover"](candidate,payload["pins"],phase)
    except SystemExit: return
    raise AssertionError("unreviewed serving state was accepted")
with patch.dict(namespace,{"command":command}):
    for phase in ["initial", "before-deploy"]: namespace["verify_session_cutover"](service,payload["pins"],phase)
    after=deepcopy(service); after["spec"]["template"]["spec"]=spec("17")
    after["spec"]["traffic"].append({"revisionName":"mickeyf-org-session-new","percent":0,"tag":"s-new"})
    namespace["verify_session_cutover"](after,payload["pins"],"after-deploy")
    for version in ["1", "17", "latest"]:
        changed=deepcopy(service); changed["spec"]["template"]["spec"]=spec(version); rejects(changed)
    for position in [1,2]:
        changed=deepcopy(service); changed["spec"]["template"]["spec"]["containers"][0]["env"][position]["value"]="false"; rejects(changed)
    changed=deepcopy(service); changed["spec"]["traffic"].append({"revisionName":"mickeyf-org-old","tag":"old"}); rejects(changed)
    changed=deepcopy(service); changed["spec"]["traffic"][0]["percent"]=50; rejects(changed)
    changed=deepcopy(service); changed["spec"]["traffic"][0]["latestRevision"]=True; rejects(changed)
    changed=deepcopy(service); changed["spec"]["template"]["spec"]["containers"][0]["env"].append({"name":"SESSION_SECRET","value":"literal"}); rejects(changed)
    rejects(service,"after-deploy")
    record["spec"]=spec("3"); rejects(service)
assert calls
`);
});

test('generated session scripts compile and Bash syntax passes without execution', () => {
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
    for (const step of resolved.filter(item => item.entrypoint === 'bash')) {
        const result = spawnSync(bash, ['--noprofile', '--norc', '-n'], { input: step.args[1], encoding: 'utf8', timeout: 10_000 });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, `${step.id}: ${result.stderr}`);
    }
    const programs = [resolved[0].args[1], resolved[4].args[1], resolved[7].args.slice(3).join('')];
    for (const step of resolved.slice(2, 7)) {
        for (const match of step.args.join('\n').matchAll(/<<'PY'\n([\s\S]*?)\nPY/gu)) programs.push(match[1]);
    }
    python('for source in payload["programs"]: compile(source,"generated.py","exec")', { programs });
    const smoke = programs[2];
    assert.match(smoke, /request\("\/auth\/renew", 200, \{\}\)/u);
    assert.match(smoke, /renewal\["loggedIn"\] is not False/u);
    assert.match(smoke, /"\/api\/users", 401, \{"type": "submit_score"/u);
    assert.match(smoke, /"\/api\/leaderboards\/three-bosses\/runs", 401/u);
    assert.doesNotMatch(smoke, /SUBMISSIONS_FROZEN|SUBMISSION_DISABLED/u);
});
