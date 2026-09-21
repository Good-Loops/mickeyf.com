"""Read-only trust and deployment-exclusion checks for the frozen candidate.

Materialized by the offline renderer; never import repository code in Cloud Build.
The Artifact Registry response is read through authenticated Google APIs. Envelope
metadata is checked here; this is not an independent cryptographic key verifier.
"""
import base64
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

PROJECT = "noted-reef-387021"
NUMBER = "1012884798546"
REGION = "global"
SERVICE = "mickeyf-org"
BUILD_SA = f"projects/{PROJECT}/serviceAccounts/cloud-build@{PROJECT}.iam.gserviceaccount.com"
DEPLOY_SA = f"projects/{PROJECT}/serviceAccounts/mickeyf-backend-deploy@{PROJECT}.iam.gserviceaccount.com"
REPOSITORY = "https://github.com/Good-Loops/mickeyf.com.git"
IMAGE = f"us-central1-docker.pkg.dev/{PROJECT}/cloud-run-source-deploy/cloud-run-source-deploy"
BUILDER = "gcr.io/cloud-builders/docker:latest@sha256:661e95acd923514f71f47ce7b390e06a8d31b15febecf772e506babf62960528"
STAGE_A = "ef5a2981-95be-4f4d-af91-f997fde73356"
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"


def reject(message):
    raise SystemExit(f"Frozen candidate preflight rejected: {message}")


def validate_session_secret_version(pins):
    version = pins.get("sessionSecretVersion") if isinstance(pins, dict) else None
    if not isinstance(version, str) or re.fullmatch(r"[1-9][0-9]*", version) is None:
        reject("sessionSecretVersion must be an explicit positive decimal string without aliases or whitespace")
    return version


def command(arguments):
    try:
        result = subprocess.run(["gcloud", *arguments], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        reject("read-only gcloud command did not complete")
    if result.returncode or len(result.stdout) > 16 * 1024 * 1024:
        reject("read-only gcloud command failed or exceeded output limit")
    try:
        return json.loads(result.stdout)
    except (UnicodeError, json.JSONDecodeError):
        reject("read-only gcloud response was not JSON")


def timestamp(raw):
    try:
        value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        reject("build timestamp is malformed")
    if value.tzinfo is None:
        reject("build timestamp has no timezone")
    return value


def approved(build):
    approval = build.get("approval") or {}
    return (approval.get("config", {}).get("approvalRequired") is True
            and approval.get("state") == "APPROVED"
            and approval.get("result", {}).get("decision") == "APPROVED")


def safe_options(options, require_provenance=False):
    allowed = {"logging", "substitutionOption", "dynamicSubstitutions", "pool"}
    if require_provenance:
        allowed.add("requestedVerifyOption")
    if (not isinstance(options, dict) or set(options) - allowed
            or options.get("logging") != "CLOUD_LOGGING_ONLY"
            or options.get("requestedVerifyOption") not in (None, "VERIFIED")
            or (require_provenance and options.get("requestedVerifyOption") != "VERIFIED")
            or options.get("substitutionOption") not in (None, "ALLOW_LOOSE")
            or ("dynamicSubstitutions" in options and options["dynamicSubstitutions"] is not True)
            or ("pool" in options and options["pool"] != {})):
        reject("build options contain unreviewed execution configuration")


def substitutions(pins):
    commit = pins["sourceCommit"]
    return {
        "COMMIT_SHA": commit, "REVISION_ID": commit, "SHORT_SHA": commit[:7],
        "REPO_FULL_NAME": "Good-Loops/mickeyf.com", "REPO_NAME": "mickeyf.com",
        "TRIGGER_BUILD_CONFIG_PATH": "cloudbuild.candidate.yaml",
        "TRIGGER_NAME": pins["sourceTriggerName"], "_GCP_PROJECT_ID": PROJECT,
        "_REPO_NAME": "cloud-run-source-deploy",
    }


def verify_source(build, trigger, pins, now):
    commit, build_id, digest = pins["sourceCommit"], pins["sourceBuildId"], pins["imageDigest"]
    if (build.get("id") != build_id
            or build.get("name") != f"projects/{NUMBER}/locations/global/builds/{build_id}"
            or build.get("projectId") != PROJECT or build.get("status") != "SUCCESS"
            or build.get("buildTriggerId") != pins["sourceTriggerId"]
            or build.get("serviceAccount") != BUILD_SA or not approved(build)):
        reject("source build identity, status, identity or approval does not match")
    created, started, finished = (timestamp(build.get(key)) for key in ("createTime", "startTime", "finishTime"))
    if not created <= started <= finished or not now - timedelta(hours=2) <= finished <= now + timedelta(minutes=5):
        reject("source build is stale or timestamps are unordered")
    source = {"url": REPOSITORY, "revision": commit}
    if (build.get("source") != {"gitSource": source}
            or build.get("sourceProvenance", {}).get("resolvedGitSource") != source
            or build.get("substitutions") != substitutions(pins)):
        reject("requested/resolved source or substitutions do not match the exact commit")
    safe_options(build.get("options"), require_provenance=True)
    if any(build.get(key) for key in ("availableSecrets", "secrets", "dependencies")):
        reject("image-only build acquired secrets or additional dependencies")
    tag = f"{IMAGE}:{commit}"
    if (build.get("images") != [tag] or build.get("artifacts") != {"images": [tag]}
            or len(build.get("results", {}).get("images", [])) != 1):
        reject("image-only build artifacts differ")
    image = build["results"]["images"][0]
    if image.get("name") != tag or image.get("digest") != digest:
        reject("source image digest does not match")
    first = {"id": "Require exact source commit", "name": BUILDER, "entrypoint": "sh", "args": ["-ceu", (
        f"commit='{commit}'\n" 'test "${#commit}" -eq 40\n' 'case "$commit" in\n'
        "  *[!0-9a-f]*) printf 'COMMIT_SHA must be 40 lowercase hexadecimal characters.\\n' >&2; exit 1 ;;\n"
        "esac")]}
    second = {"id": "Build backend candidate image", "name": BUILDER, "dir": ".", "args": ["build", "-t", tag, "."]}
    steps = build.get("steps") or []
    if len(steps) != 2:
        reject("image-only build step count differs")
    for observed, expected in zip(steps, (first, second)):
        # Timing/pullTiming are API-added output, not executable configuration.
        actual = {key: value for key, value in observed.items() if key not in {"status", "timing", "pullTiming", "exitCode"}}
        if observed.get("status") != "SUCCESS" or observed.get("exitCode", 0) != 0 or actual != expected:
            reject("image-only build steps differ from the reviewed configuration")
    expected_source = {"ref": pins["sourceRef"], "repoType": "GITHUB", "uri": REPOSITORY.removesuffix(".git")}
    expected_file = {"path": "cloudbuild.candidate.yaml", "repoType": "GITHUB", "revision": pins["sourceRef"],
                     "uri": REPOSITORY.removesuffix(".git")}
    if (trigger.get("id") != pins["sourceTriggerId"]
            or trigger.get("resourceName") != f"projects/{PROJECT}/locations/global/triggers/{pins['sourceTriggerId']}"
            or trigger.get("name") != pins["sourceTriggerName"] or trigger.get("disabled") is True
            or trigger.get("serviceAccount") != BUILD_SA
            or trigger.get("approvalConfig") != {"approvalRequired": True}
            or trigger.get("sourceToBuild") != expected_source or trigger.get("gitFileSource") != expected_file):
        reject("manual source trigger identity or image-only source configuration differs")
    if set(trigger) & {"build", "filename", "github", "pubsubConfig", "webhookConfig", "repositoryEventConfig", "developerConnectEventConfig"}:
        reject("manual source trigger gained an alternate execution source")


def verify_provenance(provenance, pins):
    digest, commit, build_id = pins["imageDigest"], pins["sourceCommit"], pins["sourceBuildId"]
    target = f"{IMAGE}@{digest}"
    summary = provenance.get("image_summary") or {}
    expected_summary = {"digest": digest, "fully_qualified_digest": target,
                        "registry": "us-central1-docker.pkg.dev", "repository": "cloud-run-source-deploy"}
    if ({key: summary.get(key) for key in expected_summary} != expected_summary
            or summary.get("slsa_build_level") not in (3, "unknown")):
        reject("provenance image summary differs")
    occurrences = provenance.get("provenance_summary", {}).get("provenance")
    if not isinstance(occurrences, list):
        reject("provenance occurrences are missing")
    matches = [item for item in occurrences if isinstance(item, dict) and item.get("build", {}).get("inTotoSlsaProvenanceV1")]
    if len(matches) != 1:
        reject("SLSA v1 occurrence is missing or ambiguous")
    occurrence = matches[0]
    if (occurrence.get("kind") != "BUILD" or occurrence.get("resourceUri") != f"https://{target}"
            or occurrence.get("noteName") != f"projects/verified-builder/notes/intoto_slsa_v1_{build_id}"):
        reject("SLSA v1 occurrence identity differs")
    statement = occurrence["build"]["inTotoSlsaProvenanceV1"]
    envelope = occurrence.get("envelope") or {}
    signatures = envelope.get("signatures") or []
    if (envelope.get("payloadType") != "application/vnd.in-toto+json" or len(signatures) != 1
            or signatures[0].get("keyid") != "projects/verified-builder/locations/global/keyRings/attestor/cryptoKeys/google-hosted-worker/cryptoKeyVersions/1"
            or not isinstance(signatures[0].get("sig"), str) or not signatures[0]["sig"]):
        reject("SLSA v1 signature envelope metadata differs")
    try:
        if json.loads(base64.b64decode(envelope["payload"], validate=True)) != statement:
            reject("SLSA envelope payload and displayed statement disagree")
        # Container Analysis serializes this bytes field with URL-safe base64.
        # Keep strict alphabet validation; do not silently discard invalid bytes.
        if not base64.b64decode(signatures[0]["sig"], altchars=b"-_", validate=True):
            reject("SLSA signature is empty")
    except (KeyError, ValueError, UnicodeError):
        reject("SLSA envelope is malformed")
    if (statement.get("_type") != "https://in-toto.io/Statement/v1"
            or statement.get("predicateType") != "https://slsa.dev/provenance/v1"
            or statement.get("subject") != [{"digest": {"sha256": digest.removeprefix("sha256:")}, "name": f"https://{IMAGE}:{commit}"}]):
        reject("SLSA v1 statement subject differs")
    predicate = statement.get("predicate") or {}
    definition, details = predicate.get("buildDefinition") or {}, predicate.get("runDetails") or {}
    if (definition.get("buildType") != "https://cloud.google.com/build/gcb-buildtypes/google-worker/v1"
            or definition.get("externalParameters") != {"substitutions": {}}):
        reject("SLSA build type or external substitutions differ")
    system = {key: value for key, value in substitutions(pins).items() if not key.startswith("_")}
    system.update({"BUILD_ID": build_id, "LOCATION": REGION, "PROJECT_NUMBER": NUMBER,
                   "SERVICE_ACCOUNT": BUILD_SA, "SERVICE_ACCOUNT_EMAIL": BUILD_SA.split("/")[-1]})
    internal = definition.get("internalParameters") or {}
    if (internal.get("systemSubstitutions") != system
            or internal.get("triggerUri") != f"projects/{NUMBER}/locations/global/triggers/{pins['sourceTriggerId']}"):
        reject("SLSA source commit, build identity or trigger differs")
    dependencies = definition.get("resolvedDependencies") or []
    builder_digest = BUILDER.split("sha256:")[1]
    expected_dependencies = [
        {"digest": {"gitCommit": commit}, "uri": f"git+{REPOSITORY}"},
        {"digest": {"sha256": builder_digest}, "uri": f"{BUILDER}@sha256:{builder_digest}"},
    ]
    if (not isinstance(dependencies, list) or len(dependencies) != 2
            or sorted(json.dumps(item, sort_keys=True) for item in dependencies)
            != sorted(json.dumps(item, sort_keys=True) for item in expected_dependencies)):
        reject("SLSA exact Git source and builder dependencies differ")
    if (details.get("builder") != {"id": "https://cloudbuild.googleapis.com/GoogleHostedWorker"}
            or details.get("metadata", {}).get("invocationId") != f"https://cloudbuild.googleapis.com/v1/projects/{PROJECT}/locations/global/builds/{build_id}"):
        reject("SLSA hosted builder or invocation differs")


def stable_service(service):
    metadata, status, spec = service.get("metadata") or {}, service.get("status") or {}, service.get("spec") or {}
    generation = metadata.get("generation")
    if (metadata.get("name") != SERVICE or generation is None or status.get("observedGeneration") != generation
            or not any(item.get("type") == "Ready" and item.get("status") == "True" for item in status.get("conditions", []))):
        reject("service is not settled and Ready")
    def traffic(items):
        if not isinstance(items, list) or not items:
            reject("explicit service traffic is missing")
        normalized, tags = [], set()
        for item in items:
            percent = item.get("percent", 0)
            revision = item.get("revisionName")
            tag = item.get("tag")
            if (item.get("latestRevision") is True or not isinstance(revision, str) or not revision.startswith("mickeyf-org-")
                    or type(percent) is not int or not 0 <= percent <= 100
                    or (tag is not None and (not isinstance(tag, str) or not tag or tag in tags))):
                reject("traffic must use explicit settled revisions, without latest or duplicate tags")
            if tag is not None:
                tags.add(tag)
            normalized.append((revision, percent, tag or ""))
        if sum(item[1] for item in normalized) != 100:
            reject("explicit traffic does not total 100 percent")
        return [list(item) for item in sorted(normalized)]
    desired, resolved = traffic(spec.get("traffic")), traffic(status.get("traffic"))
    if desired != resolved:
        reject("desired and resolved traffic differ")
    return {"generation": generation, "traffic": desired,
            "latestCreatedRevisionName": status.get("latestCreatedRevisionName"),
            "latestReadyRevisionName": status.get("latestReadyRevisionName")}


def verify_exclusion(stage_a, stage_b, active_builds, deploy_build, deploy_trigger, triggers, pins, build_id, trigger_id):
    for record, expected_id, expected_name in ((stage_a, STAGE_A, "main-push-mickeyf-com"),
            (stage_b, pins["canonicalDeployTriggerId"], pins["canonicalDeployTriggerName"])):
        if (record.get("id") != expected_id or record.get("name") != expected_name
                or record.get("resourceName") != f"projects/{PROJECT}/locations/global/triggers/{expected_id}"
                or record.get("disabled") is not True):
            reject("canonical Stage A/B triggers must be disabled explicitly")
    known = {STAGE_A, pins["canonicalDeployTriggerId"], pins["sourceTriggerId"], trigger_id}
    if not isinstance(triggers, list) or any(item.get("id") not in known and item.get("disabled") is not True for item in triggers):
        reject("an unreviewed enabled Cloud Build trigger exists")
    # Reject all other active builds, not only a guessed subset of deploy steps.
    if (not isinstance(active_builds, list) or any(item.get("id") != build_id for item in active_builds)
            or len(active_builds) != 1):
        reject("another queued, pending-approval or running Cloud Build exists")
    if (deploy_build.get("id") != build_id or deploy_build.get("projectId") != PROJECT
            or deploy_build.get("name") != f"projects/{NUMBER}/locations/global/builds/{build_id}"
            or deploy_build.get("buildTriggerId") != trigger_id or deploy_build.get("status") != "WORKING"
            or deploy_build.get("serviceAccount") not in (DEPLOY_SA, DEPLOY_SA.replace(f"projects/{PROJECT}/", "projects/-/"))
            or not approved(deploy_build) or any(deploy_build.get(key) for key in ("source", "images", "artifacts", "availableSecrets", "secrets", "dependencies"))):
        reject("current deployment is not an approved source-less build under the fixed deploy identity")
    if (deploy_trigger.get("id") != trigger_id or deploy_trigger.get("disabled") is True
            or deploy_trigger.get("name") != pins["deploymentTriggerName"]
            or deploy_trigger.get("resourceName") != f"projects/{PROJECT}/locations/global/triggers/{trigger_id}"
            or deploy_trigger.get("approvalConfig") != {"approvalRequired": True}
            or deploy_trigger.get("serviceAccount") not in (DEPLOY_SA, DEPLOY_SA.replace(f"projects/{PROJECT}/", "projects/-/"))
            or not isinstance(deploy_trigger.get("build"), dict)):
        reject("temporary deployment trigger is not the reviewed source-less approval-required trigger")
    if set(deploy_trigger) & {"filename", "gitFileSource", "sourceToBuild", "github", "pubsubConfig", "webhookConfig", "repositoryEventConfig", "developerConnectEventConfig"}:
        reject("temporary deploy trigger gained a source or event binding")
    safe_options(deploy_build.get("options"))
    inline = deploy_trigger["build"]
    safe_options(inline.get("options"))
    if deploy_build.get("timeout") != "2400s" or inline.get("timeout") != "2400s":
        reject("deployment deadline differs from the reviewed package")
    if any(inline.get(key) for key in ("source", "images", "artifacts", "availableSecrets", "secrets", "dependencies")):
        reject("temporary inline configuration gained source, artifacts or secrets")


def main():
    pins_path, build_id, trigger_id, approval, phase = sys.argv[1:]
    with open(pins_path, encoding="utf-8") as handle:
        pins = json.load(handle)
    session_secret_version = validate_session_secret_version(pins)
    if (re.fullmatch(UUID, build_id) is None or re.fullmatch(UUID, trigger_id) is None
            or trigger_id in (STAGE_A, pins["canonicalDeployTriggerId"], pins["sourceTriggerId"])
            or approval != f"freeze-zero-traffic:{pins['sourceCommit']}:{pins['sourceBuildId']}:{pins['imageDigest']}:session-secret:{session_secret_version}"
            or phase not in ("initial", "before-deploy", "after-deploy")):
        reject("explicit one-shot approval or current deployment identity is invalid")
    def build(identifier):
        return command(["builds", "describe", identifier, f"--project={PROJECT}", "--region=global", "--format=json"])
    def trigger(identifier):
        return command(["builds", "triggers", "describe", identifier, f"--project={PROJECT}", "--region=global", "--format=json"])
    source = build(pins["sourceBuildId"])
    verify_source(source, trigger(pins["sourceTriggerId"]), pins, datetime.now(timezone.utc))
    newest = command(["builds", "list", f"--project={PROJECT}", "--region=global", f"--filter=buildTriggerId={pins['sourceTriggerId']}",
                      "--sort-by=~createTime", "--limit=1", "--format=json"])
    if len(newest) != 1 or newest[0].get("id") != pins["sourceBuildId"]:
        reject("source candidate is not the newest build of its dedicated trigger")
    provenance = command(["artifacts", "docker", "images", "describe", f"{IMAGE}@{pins['imageDigest']}",
                          f"--project={PROJECT}", "--show-provenance", "--format=json"])
    verify_provenance(provenance, pins)
    tagged = command(["artifacts", "docker", "images", "describe", f"{IMAGE}:{pins['sourceCommit']}", f"--project={PROJECT}", "--format=json"])
    if tagged.get("image_summary", {}).get("digest") != pins["imageDigest"]:
        reject("full-commit image tag no longer resolves to the approved digest")
    active, triggers = [], []
    for region in ("global", "us-central1"):
        regional_builds = command(["builds", "list", f"--project={PROJECT}", f"--region={region}",
                                   "--filter=status=(PENDING QUEUED WORKING)", "--format=json"])
        regional_triggers = command(["builds", "triggers", "list", f"--project={PROJECT}", f"--region={region}", "--format=json"])
        if not isinstance(regional_builds, list) or not isinstance(regional_triggers, list):
            reject("global/regional execution inventory is malformed")
        active.extend(regional_builds)
        triggers.extend(regional_triggers)
    verify_exclusion(trigger(STAGE_A), trigger(pins["canonicalDeployTriggerId"]), active,
                     build(build_id), trigger(trigger_id), triggers, pins, build_id, trigger_id)
    service = command(["run", "services", "describe", SERVICE, f"--project={PROJECT}", "--region=us-central1", "--format=json"])
    snapshot = stable_service(service)
    baseline = "/workspace/frozen-before.json"
    if phase == "initial":
        with open(baseline, "x", encoding="utf-8") as handle:
            json.dump(snapshot, handle, sort_keys=True)
        compact = pins["sourceBuildId"].replace("-", "")
        state = {"build_id": pins["sourceBuildId"], "candidate_tag": f"f-{compact}", "commit": pins["sourceCommit"],
                 "digest": pins["imageDigest"], "revision_name": f"mickeyf-org-freeze-{compact}",
                 "revision_suffix": f"freeze-{compact}", "target_image": f"{IMAGE}@{pins['imageDigest']}"}
        with open("/workspace/verified-stage-a.json", "x", encoding="utf-8") as handle:
            json.dump(state, handle, sort_keys=True)
    else:
        with open(baseline, encoding="utf-8") as handle:
            before = json.load(handle)
        if phase == "before-deploy":
            if snapshot != before:
                reject("service changed during scan/preflight; regenerate/review the one-shot deployment")
        else:
            compact = pins["sourceBuildId"].replace("-", "")
            revision = f"mickeyf-org-freeze-{compact}"
            expected_traffic = sorted(before["traffic"] + [[revision, 0, f"f-{compact}"]])
            if (snapshot["traffic"] != expected_traffic or int(snapshot["generation"]) != int(before["generation"]) + 1
                    or snapshot["latestCreatedRevisionName"] != revision or snapshot["latestReadyRevisionName"] != revision):
                reject("post-deploy state changed anything beyond the exact new frozen tag/revision")
    print(f"Frozen candidate trust/exclusion preflight passed ({phase}); no production mutation performed by preflight.")


if __name__ == "__main__":
    main()
