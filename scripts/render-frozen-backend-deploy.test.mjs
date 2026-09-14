import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { deploymentStepsFingerprint } from './frozen-backend-traffic.mjs';
import {
    CANONICAL_SHA256, frozenDeploymentStepsSha256, renderFrozenBackendDeployConfig,
    resolveFrozenDeploymentSteps, validateFrozenPins,
} from './render-frozen-backend-deploy.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const preflight = read('./render-frozen-backend-deploy.preflight.py');
const pins = {
    sourceBuildId: '123e4567-e89b-42d3-a456-426614174000', sourceCommit: 'a'.repeat(40),
    imageDigest: `sha256:${'b'.repeat(64)}`, sourceTriggerId: '648fadca-3cd1-4b57-9d35-0f62a1468443',
    sourceTriggerName: 'feature-new-leaderboard-candidate', sourceRef: 'refs/heads/feature/three-bosses-polish',
    deploymentTriggerName: 'frozen-backend-receipts',
};
const input = { canonical: read('../cloudbuild.deploy.yaml'), candidate: read('../cloudbuild.candidate.yaml'), preflight, pins };
const config = renderFrozenBackendDeployConfig(input);
const buildId = '223e4567-e89b-42d3-a456-426614174000';
const deploymentTriggerId = '323e4567-e89b-42d3-a456-426614174000';
const approval = `freeze-zero-traffic:${pins.sourceCommit}:${pins.sourceBuildId}:${pins.imageDigest}`;
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

test('source-less generated package requires approval and contains no traffic promotion, expiry, notification or secrets payload', () => {
    assert.equal(config.steps.length, 7);
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
    assert.match(config.steps[4].args[1], /blocking_count != 0/u);
    const smoke = config.steps[6].args.slice(3).join('');
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
    const source = resolved[4].args[1];
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
    const programs = [resolved[0].args[1], resolved[6].args.slice(3).join('')];
    for (const step of resolved.slice(2, 6)) {
        for (const match of step.args.join('\n').matchAll(/<<'PY'\n([\s\S]*?)\nPY/gu)) programs.push(match[1]);
    }
    const result = python('for source in payload["programs"]: compile(source,"generated.py","exec")\nprint(len(payload["programs"]))', { programs });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Number(result.stdout.trim()) >= 8);
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
