from __future__ import annotations

import importlib.util
import http.client
import json
import os
import stat
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "check_maven_central_deployment.py"
SPEC = importlib.util.spec_from_file_location(
    "check_maven_central_deployment",
    MODULE_PATH,
)
assert SPEC is not None
check_maven_central_deployment = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(check_maven_central_deployment)


DEPLOYMENT_ID = "12345678-1234-4abc-8def-1234567890ab"


def status_document(state: str, **extra: object) -> bytes:
    return json.dumps(
        {
            "deploymentId": DEPLOYMENT_ID,
            "deploymentState": state,
            **extra,
        }
    ).encode()


class MavenCentralDeploymentTests(unittest.TestCase):
    def test_capture_requires_one_canonical_identifier_without_disclosure(self) -> None:
        rejected = (
            b"",
            b"not-an-identifier",
            DEPLOYMENT_ID.upper().encode(),
            f"{DEPLOYMENT_ID}\nsecond".encode(),
        )
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "deployment-id"
            for raw in rejected:
                with self.subTest(raw=raw):
                    with self.assertRaises(
                        check_maven_central_deployment.DeploymentError
                    ) as context:
                        check_maven_central_deployment.capture_deployment_id(
                            raw,
                            output,
                        )
                    self.assertEqual(
                        str(context.exception),
                        "Maven Central deployment identifier is invalid.",
                    )
                    if raw:
                        self.assertNotIn(
                            raw.decode(errors="ignore"),
                            str(context.exception),
                        )
                    self.assertFalse(output.exists())

    def test_capture_creates_a_private_regular_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "deployment-id"

            check_maven_central_deployment.capture_deployment_id(
                DEPLOYMENT_ID.encode(),
                output,
            )

            file_stat = output.lstat()
            self.assertTrue(stat.S_ISREG(file_stat.st_mode))
            self.assertEqual(stat.S_IMODE(file_stat.st_mode), 0o600)
            self.assertEqual(
                check_maven_central_deployment.read_deployment_id(output),
                DEPLOYMENT_ID,
            )

    def test_capture_rejects_existing_files_and_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "target"
            target.write_text("unchanged\n", encoding="utf-8")
            link = root / "deployment-id"
            link.symlink_to(target)

            with self.assertRaises(
                check_maven_central_deployment.DeploymentError
            ):
                check_maven_central_deployment.capture_deployment_id(
                    DEPLOYMENT_ID.encode(),
                    link,
                )

            self.assertEqual(target.read_text(encoding="utf-8"), "unchanged\n")
            self.assertTrue(link.is_symlink())

    def test_read_rejects_a_missing_identifier_without_path_disclosure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "absent-deployment-id"

            with self.assertRaises(
                check_maven_central_deployment.DeploymentError
            ) as context:
                check_maven_central_deployment.read_deployment_id(missing)

        self.assertEqual(
            str(context.exception),
            "Maven Central deployment identifier is unavailable.",
        )
        self.assertNotIn(str(missing), str(context.exception))

    def test_read_uses_one_bounded_non_following_file_descriptor(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            identifier_file = root / "deployment-id"
            identifier_file.write_text(f"{DEPLOYMENT_ID}\n", encoding="ascii")
            identifier_file.chmod(0o600)
            link = root / "deployment-link"
            link.symlink_to(identifier_file)

            with mock.patch.object(
                Path,
                "read_bytes",
                side_effect=AssertionError("identifier path was reopened"),
            ):
                self.assertEqual(
                    check_maven_central_deployment.read_deployment_id(
                        identifier_file
                    ),
                    DEPLOYMENT_ID,
                )
            with self.assertRaises(
                check_maven_central_deployment.DeploymentError
            ):
                check_maven_central_deployment.read_deployment_id(link)

            identifier_file.write_bytes(b"x" * 129)
            identifier_file.chmod(0o600)
            with self.assertRaises(
                check_maven_central_deployment.DeploymentError
            ):
                check_maven_central_deployment.read_deployment_id(
                    identifier_file
                )

    def test_terminal_failure_redacts_portal_details(self) -> None:
        hidden = "repository validation disclosed detail"
        state = check_maven_central_deployment.parse_status_document(
            status_document("FAILED", errors={"pkg": [hidden]}),
            DEPLOYMENT_ID,
        )

        with self.assertRaises(
            check_maven_central_deployment.DeploymentError
        ) as context:
            check_maven_central_deployment.wait_for_deployment(
                lambda: state,
                timeout_seconds=60,
                poll_interval_seconds=1,
            )

        self.assertEqual(
            str(context.exception),
            "Maven Central deployment failed.",
        )
        self.assertNotIn(hidden, str(context.exception))
        self.assertNotIn(DEPLOYMENT_ID, str(context.exception))

    def test_unexpected_state_fails_closed_without_reflection(self) -> None:
        hidden_state = "PUBLISHED_WITH_INTERNAL_DETAIL"

        with self.assertRaises(
            check_maven_central_deployment.DeploymentError
        ) as context:
            check_maven_central_deployment.parse_status_document(
                status_document(hidden_state),
                DEPLOYMENT_ID,
            )

        self.assertEqual(
            str(context.exception),
            "Maven Central deployment status is invalid.",
        )
        self.assertNotIn(hidden_state, str(context.exception))

    def test_status_requires_the_expected_identifier_and_bounded_json(self) -> None:
        wrong_id = status_document("PUBLISHED").replace(
            DEPLOYMENT_ID.encode(),
            b"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        )
        for body in (wrong_id, b"{", b"x" * 65_537):
            with self.subTest(body_length=len(body)):
                with self.assertRaises(
                    check_maven_central_deployment.DeploymentError
                ):
                    check_maven_central_deployment.parse_status_document(
                        body,
                        DEPLOYMENT_ID,
                    )

    def test_status_parser_failures_never_reflect_parser_details(self) -> None:
        hidden = "parser disclosed detail"
        for parser_error in (ValueError(hidden), RecursionError(hidden)):
            with self.subTest(error_type=type(parser_error).__name__):
                with mock.patch.object(
                    check_maven_central_deployment.json,
                    "loads",
                    side_effect=parser_error,
                ):
                    with self.assertRaises(
                        check_maven_central_deployment.DeploymentError
                    ) as context:
                        check_maven_central_deployment.parse_status_document(
                            status_document("PUBLISHED"),
                            DEPLOYMENT_ID,
                        )
                self.assertEqual(
                    str(context.exception),
                    "Maven Central deployment status is invalid.",
                )
                self.assertNotIn(hidden, str(context.exception))

    def test_status_uses_the_authenticated_post_endpoint(self) -> None:
        requests: list[object] = []

        class Response:
            def __enter__(self) -> "Response":
                return self

            def __exit__(self, *args: object) -> None:
                return None

            def read(self, limit: int) -> bytes:
                self_limit = limit
                if self_limit != 65_537:
                    raise AssertionError("status read must remain bounded")
                return status_document("PUBLISHED")

        def open_status(request: object, *, timeout: int) -> Response:
            self.assertEqual(timeout, 20)
            requests.append(request)
            return Response()

        state = check_maven_central_deployment.fetch_deployment_state(
            DEPLOYMENT_ID,
            "publisher",
            "value",
            opener=open_status,
        )

        self.assertEqual(state, "PUBLISHED")
        self.assertEqual(len(requests), 1)
        request = requests[0]
        self.assertEqual(request.get_method(), "POST")
        parsed = urllib.parse.urlparse(request.full_url)
        self.assertEqual(
            f"{parsed.scheme}://{parsed.netloc}{parsed.path}",
            "https://central.sonatype.com/api/v1/publisher/status",
        )
        self.assertEqual(
            urllib.parse.parse_qs(parsed.query),
            {"id": [DEPLOYMENT_ID]},
        )
        self.assertTrue(request.get_header("Authorization").startswith("Bearer "))

    def test_status_rejects_redirects_without_a_second_request(self) -> None:
        hidden_target = "http://unexpected.example/disclosed"

        with self.assertRaises(
            check_maven_central_deployment.DeploymentError
        ) as context:
            check_maven_central_deployment.RejectRedirects().redirect_request(
                object(),
                object(),
                302,
                "redirect",
                {},
                hidden_target,
            )

        self.assertEqual(
            str(context.exception),
            "Maven Central deployment status is unavailable.",
        )
        self.assertNotIn(hidden_target, str(context.exception))

    def test_protocol_failures_are_retryable_without_response_disclosure(self) -> None:
        hidden = "remote protocol detail"

        def fail_protocol(*args: object, **kwargs: object) -> object:
            raise http.client.BadStatusLine(hidden)

        with self.assertRaises(
            check_maven_central_deployment.TransientStatusError
        ) as context:
            check_maven_central_deployment.fetch_deployment_state(
                DEPLOYMENT_ID,
                "publisher",
                "value",
                opener=fail_protocol,
            )

        self.assertNotIn(hidden, str(context.exception))

    def test_wait_accepts_only_published_after_all_processing_states(self) -> None:
        states = iter(("PENDING", "VALIDATING", "VALIDATED", "PUBLISHING", "PUBLISHED"))
        clock = [0.0]

        result = check_maven_central_deployment.wait_for_deployment(
            lambda: next(states),
            timeout_seconds=60,
            poll_interval_seconds=1,
            monotonic=lambda: clock[0],
            sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds),
        )

        self.assertEqual(result, "PUBLISHED")
        self.assertEqual(clock[0], 4.0)

    def test_wait_times_out_on_a_monotonic_bounded_deadline(self) -> None:
        clock = [0.0]
        calls = 0

        def fetch() -> str:
            nonlocal calls
            calls += 1
            return "VALIDATING"

        with self.assertRaises(
            check_maven_central_deployment.DeploymentError
        ) as context:
            check_maven_central_deployment.wait_for_deployment(
                fetch,
                timeout_seconds=2,
                poll_interval_seconds=1,
                monotonic=lambda: clock[0],
                sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds),
            )

        self.assertEqual(
            str(context.exception),
            "Maven Central deployment did not finish before timeout.",
        )
        self.assertEqual(calls, 3)
        self.assertEqual(clock[0], 2.0)

    def test_single_status_query_never_waits_or_uploads(self) -> None:
        slept: list[float] = []
        result = check_maven_central_deployment.wait_for_deployment(
            lambda: "PUBLISHING",
            timeout_seconds=60,
            poll_interval_seconds=1,
            once=True,
            sleep=slept.append,
        )

        self.assertEqual(result, "PROCESSING")
        self.assertEqual(slept, [])
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertIn("/api/v1/publisher/status", source)
        self.assertNotIn("/api/v1/publisher/upload", source)


if __name__ == "__main__":
    unittest.main()
