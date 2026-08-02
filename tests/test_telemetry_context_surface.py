from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CLIENT_ENTRYPOINTS = (
    ("angular", "index"),
    ("browser", "index"),
    ("express", "index"),
    ("fastify", "index"),
    ("nestjs", "index"),
    ("next", "index"),
    ("next", "client"),
    ("node", "index"),
    ("react", "index"),
    ("react-native", "index"),
    ("svelte", "index"),
    ("vue", "index"),
)


class TelemetryContextSurfaceTests(unittest.TestCase):
    def test_every_javascript_client_forwards_shared_context_to_core(self) -> None:
        for package, entrypoint in CLIENT_ENTRYPOINTS:
            for suffix in ("js", "cjs"):
                relative_path = f"js/logbrew-{package}/{entrypoint}.{suffix}"
                source = (ROOT / relative_path).read_text(encoding="utf-8")
                with self.subTest(path=relative_path):
                    self.assertRegex(source, re.compile(r"\bcontext,\s*\n"))
                    self.assertRegex(
                        source,
                        re.compile(
                            r"LogBrewClient\.create\(\{[\s\S]{0,700}?"
                            r"\bcontext(?:\s*:\s*[A-Za-z_$][A-Za-z0-9_$]*)?,",
                        ),
                    )

    def test_every_javascript_client_types_shared_context_in_both_module_formats(
        self,
    ) -> None:
        for package, entrypoint in CLIENT_ENTRYPOINTS:
            declarations = []
            for suffix in ("d.ts", "d.cts"):
                relative_path = f"js/logbrew-{package}/{entrypoint}.{suffix}"
                source = (ROOT / relative_path).read_text(encoding="utf-8")
                declarations.append(source)
                with self.subTest(path=relative_path):
                    self.assertIn("TelemetryContext", source)
                    self.assertIn("context?: TelemetryContext;", source)
            self.assertEqual(
                declarations[0],
                declarations[1],
                f"{package}/{entrypoint} ESM and CommonJS declarations drifted",
            )


if __name__ == "__main__":
    unittest.main()
