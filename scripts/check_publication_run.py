#!/usr/bin/env python3
"""Authenticate the exact completed publication boundary used by reconciliation."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from typing import Any, NoReturn


SHA = re.compile(r"[0-9a-f]{40}")
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
WORKFLOW_PATH = ".github/workflows/publish-packages.yml"

FAMILY_CONTRACTS = {
    "pypi": {
        "job": "PyPI packages",
        "failed": "Verify public PyPI installs",
        "siblings": {
            "crates.io package",
            "Maven Central package",
            "RubyGems package",
            "Packagist package",
            "Public registry verification",
            "Public SwiftPM verification",
            "npm packages",
            "NuGet package",
        },
        "required": {
            "Check out release ref": "success",
            "Build Python distributions": "success",
            "Create Python release manifest": "success",
            "Verify packed Python distributions": "success",
            "Upload Python release manifest": "success",
            "Publish logbrew-sdk to PyPI": "success",
            "Publish logbrew-fastapi to PyPI": "success",
            "Publish logbrew-flask to PyPI": "success",
            "Publish logbrew-django to PyPI": "success",
            "Verify public PyPI packages": "success",
            "Verify public PyPI installs": "failure",
        },
    },
    "nuget": {
        "job": "NuGet package / NuGet package",
        "failed": "Verify public NuGet package",
        "siblings": {
            "crates.io package",
            "Maven Central package",
            "RubyGems package",
            "Packagist package",
            "Public registry verification",
            "Public SwiftPM verification",
            "npm packages",
            "PyPI packages",
        },
        "required": {
            "Check out release ref": "success",
            "Bind immutable release source": "success",
            "Check out protected release control": "success",
            "Bind protected release control": "success",
            "Plan selected NuGet packages": "success",
            "Validate NuGet release metadata": "success",
            "Check NuGet version collision": "success",
            "Pack NuGet package": "success",
            "Publish NuGet package": "success",
            "Verify public NuGet package": "failure",
            "Verify public NuGet install": "skipped",
        },
    },
}


class RejectRedirects(urllib.request.HTTPRedirectHandler):
    """Prevent authentication from following redirects."""

    def redirect_request(
        self,
        request: urllib.request.Request,
        file_pointer: Any,
        code: int,
        message: str,
        headers: Any,
        redirected_url: str,
    ) -> None:
        del request, file_pointer, code, message, headers, redirected_url
        return None


def fail() -> NoReturn:
    raise ValueError("publication run verification failed")


def fetch_json(
    url: str,
    authorization: str,
    opener: Any | None,
) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {authorization}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    open_request = opener or urllib.request.build_opener(RejectRedirects()).open
    try:
        with open_request(request, timeout=30) as response:
            if response.getcode() != 200 or response.geturl() != request.full_url:
                fail()
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except (
        OSError,
        urllib.error.HTTPError,
        urllib.error.URLError,
        ValueError,
    ):
        fail()
    if len(raw) > MAX_RESPONSE_BYTES:
        fail()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        fail()
    if not isinstance(payload, dict):
        fail()
    return payload


def validate_run(
    run: dict[str, Any],
    repository: str,
    run_id: int,
    family: str,
    workflow_sha: str,
    source_sha: str,
) -> None:
    if (
        run.get("id") != run_id
        or run.get("event") != "workflow_dispatch"
        or run.get("path") != WORKFLOW_PATH
        or run.get("head_branch") != "main"
        or run.get("head_sha") != workflow_sha
        or run.get("display_title") != f"Publish {family} from {source_sha}"
        or run.get("conclusion") != "failure"
        or run.get("run_attempt") != 1
        or not isinstance(run.get("head_repository"), dict)
        or run["head_repository"].get("full_name") != repository
    ):
        fail()
    references = run.get("referenced_workflows", [])
    expected_path = f"{repository}/.github/workflows/publish-nuget.yml@{workflow_sha}"
    if (
        not isinstance(references, list)
        or len(references) != 1
        or not isinstance(references[0], dict)
        or references[0].get("path") != expected_path
        or references[0].get("ref") != "refs/heads/main"
        or references[0].get("sha") != workflow_sha
    ):
        fail()


def validate_jobs(payload: dict[str, Any], family: str) -> None:
    jobs = payload.get("jobs")
    if (
        not isinstance(jobs, list)
        or payload.get("total_count") != len(jobs)
        or len(jobs) > 100
    ):
        fail()
    contract = FAMILY_CONTRACTS[family]
    expected_names = {contract["job"], *contract["siblings"]}
    job_names = [job.get("name") if isinstance(job, dict) else None for job in jobs]
    if len(jobs) != len(expected_names) or set(job_names) != expected_names:
        fail()
    matching = [
        job
        for job in jobs
        if isinstance(job, dict) and job.get("name") == contract["job"]
    ]
    if len(matching) != 1 or matching[0].get("conclusion") != "failure":
        fail()
    if any(
        not isinstance(job, dict)
        or (
            job is not matching[0]
            and job.get("conclusion") not in {"skipped", "neutral"}
        )
        for job in jobs
    ):
        fail()

    steps = matching[0].get("steps")
    if not isinstance(steps, list):
        fail()
    step_results: dict[str, str] = {}
    for step in steps:
        if (
            not isinstance(step, dict)
            or not isinstance(step.get("name"), str)
            or not isinstance(step.get("conclusion"), str)
            or step["name"] in step_results
        ):
            fail()
        step_results[step["name"]] = step["conclusion"]
    if any(
        step_results.get(name) != conclusion
        for name, conclusion in contract["required"].items()
    ):
        fail()
    if {
        name for name, conclusion in step_results.items() if conclusion == "failure"
    } != {contract["failed"]}:
        fail()


def verify_publication_run(
    repository: str,
    run_id: int,
    family: str,
    workflow_sha: str,
    source_sha: str,
    authorization: str,
    *,
    opener: Any | None = None,
) -> None:
    if (
        REPOSITORY.fullmatch(repository) is None
        or run_id <= 0
        or family not in FAMILY_CONTRACTS
        or SHA.fullmatch(workflow_sha) is None
        or SHA.fullmatch(source_sha) is None
        or not authorization
    ):
        fail()
    base = f"https://api.github.com/repos/{repository}/actions/runs/{run_id}"
    run = fetch_json(base, authorization, opener)
    jobs = fetch_json(f"{base}/jobs?per_page=100", authorization, opener)
    validate_run(run, repository, run_id, family, workflow_sha, source_sha)
    validate_jobs(jobs, family)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--run-id", type=int, required=True)
    parser.add_argument("--family", choices=tuple(FAMILY_CONTRACTS), required=True)
    parser.add_argument("--workflow-sha", required=True)
    parser.add_argument("--source-sha", required=True)
    args = parser.parse_args(argv)
    authorization = os.environ.get("GITHUB_AUTHORIZATION", "")
    try:
        verify_publication_run(
            args.repository,
            args.run_id,
            args.family,
            args.workflow_sha,
            args.source_sha,
            authorization,
        )
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    print("publication run verification ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
