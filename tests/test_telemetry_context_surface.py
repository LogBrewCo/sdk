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


def client_declaration(path: Path) -> str:
    source = path.read_text(encoding="utf-8")
    for module in re.findall(r'from\s+"(\./types-[^\"]+)\.js";', source):
        source += (path.parent / f"{module}.d.ts").read_text(encoding="utf-8")
    return source


class TelemetryContextSurfaceTests(unittest.TestCase):
    def test_every_javascript_client_forwards_shared_context_to_its_runtime(self) -> None:
        for package, entrypoint in CLIENT_ENTRYPOINTS:
            for suffix in ("js", "cjs"):
                relative_path = f"js/logbrew-{package}/{entrypoint}.{suffix}"
                source = client_source(ROOT / relative_path)
                with self.subTest(path=relative_path):
                    self.assertRegex(source, re.compile(r"\bcontext,\s*\n"))
                    self.assertRegex(
                        source,
                        re.compile(
                            r"(?:LogBrewClient\.create|createLogBrewNodeClient)\(\{[\s\S]{0,700}?"
                            r"\bcontext(?:\s*:\s*[A-Za-z_$][A-Za-z0-9_$]*)?\s*[,}]",
                        ),
                    )

    def test_every_javascript_client_types_shared_context_in_both_module_formats(
        self,
    ) -> None:
        for package, entrypoint in CLIENT_ENTRYPOINTS:
            declaration_path = ROOT / f"js/logbrew-{package}/{entrypoint}.d.ts"
            declaration = declaration_path.read_text(encoding="utf-8")
            surface = client_declaration(declaration_path)
            commonjs = (ROOT / f"js/logbrew-{package}/{entrypoint}.d.cts").read_text(encoding="utf-8")
            with self.subTest(path=f"js/logbrew-{package}/{entrypoint}.d.ts"):
                self.assertIn("TelemetryContext", surface)
                self.assertRegex(surface, r"\bcontext\?: TelemetryContext(?: \| undefined)?;")
                self.assertIn(commonjs, (declaration, COMMONJS_DECLARATION_REEXPORT))


if __name__ == "__main__":
    unittest.main()
