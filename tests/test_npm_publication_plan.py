from __future__ import annotations

import importlib.util
import json
import sys
import urllib.error
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "plan_npm_publication.py"
SPEC = importlib.util.spec_from_file_location("plan_npm_publication", MODULE_PATH)
assert SPEC is not None
plan_npm_publication = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = plan_npm_publication
SPEC.loader.exec_module(plan_npm_publication)


class FakeResponse:
    def __init__(self, payload: bytes, status: int = 200) -> None:
        self.payload = payload
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None

    def getcode(self) -> int:
        return self.status

    def read(self, amount: int) -> bytes:
        return self.payload[:amount]


class NpmPublicationPlanTests(unittest.TestCase):
    def test_reports_every_collision_before_publication(self) -> None:
        metadata = {
            "@logbrew/sdk": {"0.1.7": {}, "0.1.8": {}},
            "@logbrew/node": {"0.1.5": {}},
        }

        def open_request(request, *, timeout):
            self.assertEqual(timeout, 30.0)
            name = request.full_url.rsplit("/", 1)[1]
            decoded_name = name.replace("%40", "@").replace("%2F", "/")
            payload = {"name": decoded_name, "versions": metadata[decoded_name]}
            return FakeResponse(json.dumps(payload).encode("utf-8"))

        plan = plan_npm_publication.plan_publication(
            [
                plan_npm_publication.Selection("@logbrew/sdk", "0.1.8"),
                plan_npm_publication.Selection("@logbrew/node", "0.1.5"),
            ],
            open_request=open_request,
        )

        self.assertEqual(
            plan["existingVersions"],
            ["@logbrew/sdk@0.1.8", "@logbrew/node@0.1.5"],
        )
        self.assertEqual(plan["missingPackagePages"], [])

    def test_distinguishes_a_missing_package_page_from_a_missing_version(self) -> None:
        def open_request(request, *, timeout):
            del timeout
            if request.full_url.endswith("%40logbrew%2Fnew-package"):
                raise urllib.error.HTTPError(
                    request.full_url, 404, "Not Found", {}, None
                )
            payload = {"name": "@logbrew/node", "versions": {"0.1.5": {}}}
            return FakeResponse(json.dumps(payload).encode("utf-8"))

        plan = plan_npm_publication.plan_publication(
            [
                plan_npm_publication.Selection("@logbrew/new-package", "0.1.0"),
                plan_npm_publication.Selection("@logbrew/node", "0.1.6"),
            ],
            open_request=open_request,
        )

        self.assertEqual(plan["existingVersions"], [])
        self.assertEqual(plan["missingPackagePages"], ["@logbrew/new-package"])

    def test_registry_failures_are_not_misclassified_as_missing_pages(self) -> None:
        def open_request(request, *, timeout):
            del timeout
            raise urllib.error.HTTPError(request.full_url, 503, "Unavailable", {}, None)

        with self.assertRaisesRegex(
            plan_npm_publication.PublicationPlanError,
            "HTTP 503",
        ):
            plan_npm_publication.plan_publication(
                [plan_npm_publication.Selection("@logbrew/node", "0.1.6")],
                open_request=open_request,
            )

    def test_invalid_or_mismatched_registry_metadata_fails_closed(self) -> None:
        for payload in (
            b"not-json",
            json.dumps({"name": "@logbrew/other", "versions": {}}).encode(),
            json.dumps({"name": "@logbrew/node", "versions": []}).encode(),
        ):
            with self.subTest(payload=payload):
                with self.assertRaises(plan_npm_publication.PublicationPlanError):
                    plan_npm_publication.plan_publication(
                        [
                            plan_npm_publication.Selection(
                                "@logbrew/node", "0.1.6"
                            )
                        ],
                        open_request=lambda *_args, **_kwargs: FakeResponse(payload),
                    )

    def test_selection_and_registry_inputs_are_bounded(self) -> None:
        with self.assertRaises(plan_npm_publication.PublicationPlanError):
            plan_npm_publication.parse_selection("@logbrew/node")
        with self.assertRaises(plan_npm_publication.PublicationPlanError):
            plan_npm_publication.plan_publication(
                [
                    plan_npm_publication.Selection("@logbrew/node", "0.1.6"),
                    plan_npm_publication.Selection("@logbrew/node", "0.1.7"),
                ]
            )
        with self.assertRaises(plan_npm_publication.PublicationPlanError):
            plan_npm_publication.normalized_registry(
                "https://user@example.invalid/registry"
            )

    def test_publish_workflow_blocks_collisions_before_any_publish(self) -> None:
        workflow = (ROOT / ".github/workflows/publish-packages.yml").read_text(
            encoding="utf-8"
        )

        planner = "python3 scripts/plan_npm_publication.py"
        collision = "Selected npm versions already exist and are immutable:"
        publish = "bun run tools/npm-publish/publish.mjs"
        self.assertIn(planner, workflow)
        self.assertIn(collision, workflow)
        self.assertIn(
            'JSON.parse(fs.readFileSync(process.argv[1], "utf8"))',
            workflow,
        )
        self.assertNotIn("const plan = require(process.argv[1]);", workflow)
        self.assertNotIn("mapfile -t existing_npm_versions < <(", workflow)
        self.assertIn('if [[ "$package_version" == co.logbrew.unity=* ]]', workflow)
        self.assertIn('if [[ "${#publication_plan_args[@]}" -gt 2 ]]', workflow)
        self.assertIn(
            'mapfile -t missing_npm_packages < "$missing_npm_packages_file"',
            workflow,
        )
        self.assertIn("npm publication preflight returned an invalid receipt", workflow)
        self.assertLess(workflow.index(planner), workflow.index(collision))
        self.assertLess(workflow.index(collision), workflow.index(publish))


if __name__ == "__main__":
    unittest.main()
