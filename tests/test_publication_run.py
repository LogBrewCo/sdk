from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from typing import Any


from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_publication_run.py"
MODULE_SPEC = importlib.util.spec_from_file_location("check_publication_run", SCRIPT)
assert MODULE_SPEC is not None and MODULE_SPEC.loader is not None
check_publication_run = importlib.util.module_from_spec(MODULE_SPEC)
sys.modules[MODULE_SPEC.name] = check_publication_run
MODULE_SPEC.loader.exec_module(check_publication_run)

WORKFLOW_SHA = "a" * 40
SOURCE_SHA = "b" * 40


class FakeResponse:
    def __init__(
        self, payload: dict[str, Any], url: str, *, final_url: str | None = None
    ) -> None:
        self.body = json.dumps(payload).encode()
        self.url = url
        self.final_url = final_url or url

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, amount: int) -> bytes:
        return self.body[:amount]

    def getcode(self) -> int:
        return 200

    def geturl(self) -> str:
        return self.final_url


class FakeGitHub:
    def __init__(self, run: dict[str, Any], jobs: list[dict[str, Any]]) -> None:
        self.run = run
        self.jobs = jobs
        self.redirect_jobs = False

    def open(self, request: Any, *, timeout: int) -> FakeResponse:
        del timeout
        url = request.full_url
        if url.endswith("/jobs?per_page=100"):
            final_url = f"{url}&redirected=true" if self.redirect_jobs else url
            return FakeResponse(
                {"total_count": len(self.jobs), "jobs": self.jobs},
                url,
                final_url=final_url,
            )
        return FakeResponse(self.run, url)


class PublicationRunTests(unittest.TestCase):
    def test_authenticates_exact_pypi_and_nuget_publication_boundaries(self) -> None:
        for family in ("pypi", "nuget"):
            with self.subTest(family=family):
                run_id = 123 if family == "pypi" else 456
                run, jobs = self.fixture(family, run_id)
                check_publication_run.verify_publication_run(
                    "LogBrewCo/sdk",
                    run_id,
                    family,
                    WORKFLOW_SHA,
                    SOURCE_SHA,
                    "github-authorization",
                    opener=FakeGitHub(run, jobs).open,
                )

    def test_rejects_wrong_head_missing_step_extra_job_and_redirect(self) -> None:
        cases = ("head", "step", "job", "missing-sibling", "redirect")
        for case in cases:
            with self.subTest(case=case):
                run, jobs = self.fixture("nuget", 456)
                github = FakeGitHub(run, jobs)
                if case == "head":
                    run["head_sha"] = "c" * 40
                elif case == "step":
                    jobs[0]["steps"] = [
                        step
                        for step in jobs[0]["steps"]
                        if step["name"] != "Check NuGet version collision"
                    ]
                elif case == "job":
                    jobs.append(
                        {
                            "name": "unexpected",
                            "conclusion": "success",
                            "steps": [],
                        }
                    )
                elif case == "missing-sibling":
                    jobs.pop()
                else:
                    github.redirect_jobs = True

                with self.assertRaisesRegex(
                    ValueError,
                    "publication run verification failed",
                ):
                    check_publication_run.verify_publication_run(
                        "LogBrewCo/sdk",
                        456,
                        "nuget",
                        WORKFLOW_SHA,
                        SOURCE_SHA,
                        "github-authorization",
                        opener=github.open,
                    )

    def test_rejects_missing_extra_or_mismatched_reusable_workflow(self) -> None:
        for case in ("missing", "extra", "path", "ref", "sha"):
            with self.subTest(case=case):
                run, jobs = self.fixture("pypi", 123)
                references = run["referenced_workflows"]
                if case == "missing":
                    run["referenced_workflows"] = []
                elif case == "extra":
                    references.append(dict(references[0]))
                elif case == "path":
                    references[0]["path"] = (
                        "LogBrewCo/sdk/.github/workflows/other.yml@" + WORKFLOW_SHA
                    )
                elif case == "ref":
                    references[0]["ref"] = "refs/heads/other"
                else:
                    references[0]["sha"] = "c" * 40

                with self.assertRaisesRegex(
                    ValueError,
                    "publication run verification failed",
                ):
                    check_publication_run.verify_publication_run(
                        "LogBrewCo/sdk",
                        123,
                        "pypi",
                        WORKFLOW_SHA,
                        SOURCE_SHA,
                        "github-authorization",
                        opener=FakeGitHub(run, jobs).open,
                    )

    def test_rejects_malformed_response_without_reflecting_content(self) -> None:
        marker = "do-not-reflect-this-value"
        run, jobs = self.fixture("pypi", 123)
        run["display_title"] = marker
        with self.assertRaises(ValueError) as failure:
            check_publication_run.verify_publication_run(
                "LogBrewCo/sdk",
                123,
                "pypi",
                WORKFLOW_SHA,
                SOURCE_SHA,
                "github-authorization",
                opener=FakeGitHub(run, jobs).open,
            )
        self.assertNotIn(marker, str(failure.exception))

    @staticmethod
    def fixture(
        family: str,
        run_id: int,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        run = {
            "id": run_id,
            "event": "workflow_dispatch",
            "path": ".github/workflows/publish-packages.yml",
            "head_branch": "main",
            "head_sha": WORKFLOW_SHA,
            "head_repository": {"full_name": "LogBrewCo/sdk"},
            "display_title": f"Publish {family} from {SOURCE_SHA}",
            "conclusion": "failure",
            "run_attempt": 1,
            "referenced_workflows": [
                {
                    "path": (
                        "LogBrewCo/sdk/.github/workflows/"
                        f"publish-nuget.yml@{WORKFLOW_SHA}"
                    ),
                    "ref": "refs/heads/main",
                    "sha": WORKFLOW_SHA,
                }
            ],
        }
        if family == "pypi":
            required = {
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
            }
            job_name = "PyPI packages"
        else:
            required = {
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
            }
            job_name = "NuGet package / NuGet package"
        sibling_names = {
            "crates.io package",
            "Maven Central package",
            "RubyGems package",
            "Packagist package",
            "Public registry verification",
            "Public SwiftPM verification",
            "npm packages",
        }
        sibling_names.add("NuGet package" if family == "pypi" else "PyPI packages")
        jobs = [
            {
                "name": job_name,
                "conclusion": "failure",
                "steps": [
                    {"name": name, "conclusion": conclusion}
                    for name, conclusion in required.items()
                ],
            },
        ]
        jobs.extend(
            {
                "name": sibling_name,
                "conclusion": "skipped",
                "steps": [],
            }
            for sibling_name in sorted(sibling_names)
        )
        return run, jobs


if __name__ == "__main__":
    unittest.main()
