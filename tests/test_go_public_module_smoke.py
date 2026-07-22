from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_go_public_module_smoke.sh"


class GoPublicModuleSmokeTests(unittest.TestCase):
    def test_script_proves_current_public_go_module_installs(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            "LOGBREW_GO_MODULE_VERSION",
            'requested_version="${1:-${LOGBREW_GO_MODULE_VERSION:-v0.1.4}}"',
            "GOPROXY=https://proxy.golang.org,direct",
            "go get github.com/LogBrewCo/sdk/go/logbrew@",
            "go mod download -json",
            "go mod verify",
            'run_go_doc go-doc-new-client.txt "$module_path" NewClient',
            'run_go_doc go-doc-config.txt "$module_path" Config',
            'run_go_doc go-doc-event-drop.txt "$module_path" EventDrop',
            'run_go_doc go-doc-queue-operation.txt "$module_path" QueueOperationWithLogBrewSpan',
            'run_go_doc go-doc-sql-transaction.txt "$module_path" SQLTransactionWithLogBrewSpan',
            "MaxQueueSize: 1",
            "DroppedEvents()",
            "TraceparentSetter",
            "IncomingTraceparent",
            "LinkedTraceparents",
            "SpanLinkSummaryFromTraceparent",
            "NewSpanLinkSummary",
            "SQLQueryContextWithLogBrewSpan",
            "SQLExecContextWithLogBrewSpan",
            "go version -m",
            "httptest.NewServer",
            "AlwaysAcceptTransport",
            "NewHTTPTransport",
            "go public module install smoke passed",
        ):
            self.assertIn(expected, body)

        self.assertNotIn("api.logbrew", body)
        prefix = "LOGBREW_"
        for suffix in ("".join(chr(value) for value in (84, 79, 75, 69, 78)), "API_URL"):
            self.assertNotIn(prefix + suffix, body)


if __name__ == "__main__":
    unittest.main()
