from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "check_npm_workspace_peer_release.py"
SPEC = importlib.util.spec_from_file_location(
    "check_npm_workspace_peer_release", MODULE_PATH
)
assert SPEC is not None
check_npm_workspace_peer_release = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(check_npm_workspace_peer_release)


class NpmWorkspacePeerReleaseTests(unittest.TestCase):
    def package(
        self,
        name: str,
        version: str,
        peers: dict[str, str] | None = None,
    ):
        return check_npm_workspace_peer_release.WorkspacePackage(
            directory=Path(name.replace("/", "-")),
            name=name,
            version=version,
            peer_dependencies=peers or {},
        )

    def test_local_artifact_identity_uses_the_publish_packer(self) -> None:
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertIn("def bun_pack_shasum", source)
        self.assertNotIn("def npm_pack_shasum", source)

    def test_unselected_workspace_peer_must_match_the_published_tarball(self) -> None:
        packages = {
            "@logbrew/sdk": self.package("@logbrew/sdk", "0.1.7"),
            "@logbrew/node": self.package(
                "@logbrew/node", "0.1.5", {"@logbrew/sdk": "^0.1.7"}
            ),
        }

        matching = check_npm_workspace_peer_release.validate_release_plan(
            packages,
            ["@logbrew/node"],
            lambda package: ("local-sha", "local-sha"),
        )
        mismatched = check_npm_workspace_peer_release.validate_release_plan(
            packages,
            ["@logbrew/node"],
            lambda package: ("local-sha", "published-sha"),
        )

        self.assertEqual(matching, [])
        self.assertEqual(len(mismatched), 1)
        self.assertIn("unpublished workspace content", mismatched[0])
        self.assertIn("@logbrew/sdk@0.1.7", mismatched[0])

    def test_missing_unselected_workspace_peer_release_is_blocked(self) -> None:
        packages = {
            "@logbrew/sdk": self.package("@logbrew/sdk", "0.1.7"),
            "@logbrew/node": self.package(
                "@logbrew/node", "0.1.5", {"@logbrew/sdk": "^0.1.7"}
            ),
        }

        failures = check_npm_workspace_peer_release.validate_release_plan(
            packages,
            ["@logbrew/node"],
            lambda package: ("local-sha", None),
        )

        self.assertEqual(len(failures), 1)
        self.assertIn("is not published", failures[0])

    def test_selected_workspace_peer_must_publish_before_its_consumer(self) -> None:
        packages = {
            "@logbrew/sdk": self.package("@logbrew/sdk", "0.1.7"),
            "@logbrew/node": self.package(
                "@logbrew/node", "0.1.5", {"@logbrew/sdk": "^0.1.7"}
            ),
        }

        def unexpected_lookup(package):
            raise AssertionError(f"unexpected artifact lookup for {package.name}")

        correct = check_npm_workspace_peer_release.validate_release_plan(
            packages,
            ["@logbrew/sdk", "@logbrew/node"],
            unexpected_lookup,
        )
        reversed_order = check_npm_workspace_peer_release.validate_release_plan(
            packages,
            ["@logbrew/node", "@logbrew/sdk"],
            unexpected_lookup,
        )

        self.assertEqual(correct, [])
        self.assertEqual(len(reversed_order), 1)
        self.assertIn("must publish before", reversed_order[0])

    def test_workspace_peer_range_must_include_the_local_release(self) -> None:
        packages = {
            "@logbrew/sdk": self.package("@logbrew/sdk", "0.1.7"),
            "@logbrew/node": self.package(
                "@logbrew/node", "0.1.5", {"@logbrew/sdk": "^0.1.8"}
            ),
        }

        failures = check_npm_workspace_peer_release.validate_release_plan(
            packages,
            ["@logbrew/sdk", "@logbrew/node"],
            lambda package: ("unused", "unused"),
        )

        self.assertEqual(len(failures), 1)
        self.assertIn("does not include workspace release 0.1.7", failures[0])

    def test_publish_workflow_checks_workspace_peers_before_publishing(self) -> None:
        workflow = (ROOT / ".github/workflows/publish-packages.yml").read_text(
            encoding="utf-8"
        )

        check = "python3 scripts/check_npm_workspace_peer_release.py"
        publish = "bun run tools/npm-publish/publish.mjs"
        self.assertIn(check, workflow)
        self.assertLess(workflow.index(check), workflow.index(publish))


if __name__ == "__main__":
    unittest.main()
