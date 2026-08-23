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
COMMONJS_DECLARATION_REEXPORT = 'export * from "./index";\nexport { default } from "./index";\n'


def client_source(path: Path) -> str:
    source = path.read_text(encoding="utf-8")
    delegate = re.search(r'import\s+\w+\s+from\s+"(\./[^\"]+\.cjs)";', source)
    return source if delegate is None else source + (
        path.parent / delegate.group(1)
    ).read_text(encoding="utf-8")


class TelemetryContextSurfaceTests(unittest.TestCase):
    def test_every_javascript_client_forwards_shared_context_to_core(self) -> None:
        for package, entrypoint in CLIENT_ENTRYPOINTS:
            for suffix in ("js", "cjs"):
                relative_path = f"js/logbrew-{package}/{entrypoint}.{suffix}"
                source = client_source(ROOT / relative_path)
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
            declaration = (ROOT / f"js/logbrew-{package}/{entrypoint}.d.ts").read_text(encoding="utf-8")
            commonjs = (ROOT / f"js/logbrew-{package}/{entrypoint}.d.cts").read_text(encoding="utf-8")
            with self.subTest(path=f"js/logbrew-{package}/{entrypoint}.d.ts"):
                self.assertIn("TelemetryContext", declaration)
                self.assertIn("context?: TelemetryContext;", declaration)
                self.assertIn(commonjs, (declaration, COMMONJS_DECLARATION_REEXPORT))


if __name__ == "__main__":
    unittest.main()
