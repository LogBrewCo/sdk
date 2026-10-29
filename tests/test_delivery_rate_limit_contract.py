"""Every SDK that sends events on its own handles HTTP 429 the same way.

A 429 whose JSON body has `code: "usage_limit_exceeded"`, or that carries
neither a readable `Retry-After` nor `code: "rate_limited"`, pauses delivery
until the application flushes, resumes, or restarts. A readable `Retry-After`
(delta-seconds or an HTTP date; a past date counts as zero) or
`code: "rate_limited"` starts a timed wait instead: the `Retry-After` delay,
or the usual retry backoff without one, clamped to 1 second through 1 hour,
plus up to 10 percent jitter, clamped to 1 hour again. The batch stays first
in the queue and is sent again unchanged after the wait; new events queue
within the usual limits and overflow is counted as dropped. SDKs read at most
4 KiB of a 429 body, only to find `code`, and never keep, log, or report it.

These tests require every source that handles a 429 to belong to a
registered family, and each family's tests to cover the timed wait for both
`Retry-After` forms and `rate_limited`, and the pause for
`usage_limit_exceeded`.
"""

from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_SUFFIXES = {".c", ".cc", ".cjs", ".cpp", ".cs", ".go", ".h", ".java", ".js", ".kt", ".m", ".mjs", ".php", ".py", ".rb", ".rs", ".swift"}
TEST_PARTS = {"test", "tests", "Tests", "examples", "Samples~"}
STATUS_429 = re.compile(r"(?<![\w.])429(?![\w.])")

# Family: (source roots, test files that together cover the contract).
FAMILIES: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "dotnet": (("dotnet/logbrew-dotnet/",), ("dotnet/logbrew-dotnet/tests/LogBrew.Tests/AutomaticDeliveryTests.cs",)),
    "go": (("go/logbrew/",), ("go/logbrew/retry_after_test.go",)),
    "java": (
        ("java/logbrew-java/",),
        ("java/logbrew-java/src/test/java/co/logbrew/sdk/LogBrewAutomaticDeliveryTest.java",),
    ),
    # The browser, Node, and React Native transports report the response; the core decides the wait.
    "javascript": (
        ("js/logbrew-js/", "js/logbrew-browser/", "js/logbrew-node/", "js/logbrew-react-native/"),
        (
            "js/logbrew-js/test/sdk.test.js",
            "js/logbrew-browser/test/beacon-transport.test.mjs",
            "js/logbrew-browser/test/lifecycle-delivery.test.mjs",
            "js/logbrew-node/test/fetch-transport.test.js",
            "js/logbrew-react-native/test/delivery.test.js",
        ),
    ),
    "objc": (
        ("objc/logbrew-objc/",),
        ("objc/logbrew-objc/tests/test_automatic_delivery.m", "objc/logbrew-objc/tests/test_logbrew.m"),
    ),
    "python": (("python/logbrew_py/",), ("python/logbrew_py/tests/test_automatic_delivery.py",)),
    "ruby": (("ruby/logbrew-ruby/",), ("ruby/logbrew-ruby/tests/automatic_delivery.rb",)),
    "rust": (("rust/logbrew/",), ("rust/logbrew/tests/automatic_delivery.rs", "rust/logbrew/tests/sdk_flow.rs")),
    "swift": (
        ("swift/logbrew-swift/",),
        ("swift/logbrew-swift/Tests/LogBrewTests/RateLimitDeliveryTests.swift",),
    ),
}
# Each covers: rate_limited code, usage_limit_exceeded code, Retry-After seconds, and an HTTP date.
REQUIRED_TEST_TEXT = ("rate_limited", "usage_limit_exceeded", "retry-after", "gmt")


def tracked_sources() -> list[str]:
    output = subprocess.run(
        ["git", "ls-files", "--", "*/*"], cwd=ROOT, capture_output=True, check=True, text=True
    ).stdout
    return [
        path
        for path in output.splitlines()
        if Path(path).suffix in SOURCE_SUFFIXES
        and not TEST_PARTS.intersection(Path(path).parts)
        and not path.startswith(("scripts/", "tools/", "tests/", ".github/"))
    ]


class DeliveryRateLimitContractTests(unittest.TestCase):
    def test_every_source_that_handles_429_is_registered(self) -> None:
        unregistered = []
        for path in tracked_sources():
            text = (ROOT / path).read_text(encoding="utf-8", errors="ignore")
            if STATUS_429.search(text) and not any(path.startswith(roots) for roots, _ in FAMILIES.values()):
                unregistered.append(path)
        self.assertEqual(unregistered, [], "register these families in FAMILIES")

    def test_registered_sources_distinguish_both_codes(self) -> None:
        sources = tracked_sources()
        for family, (roots, _) in FAMILIES.items():
            text = "\n".join(
                (ROOT / path).read_text(encoding="utf-8", errors="ignore") for path in sources if path.startswith(roots)
            )
            for code in ("rate_limited", "usage_limit_exceeded"):
                self.assertIn(code, text, f"{family} sources never mention {code}")

    def test_registered_tests_cover_the_timed_wait_and_the_pause(self) -> None:
        for family, (_, test_paths) in FAMILIES.items():
            text = "\n".join((ROOT / path).read_text(encoding="utf-8") for path in test_paths).lower()
            for required in REQUIRED_TEST_TEXT:
                self.assertIn(required, text, f"{family} tests never cover {required}")


if __name__ == "__main__":
    unittest.main()
