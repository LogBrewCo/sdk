from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "check_confidentiality_scan.py"
SPEC = importlib.util.spec_from_file_location("check_confidentiality_scan", MODULE_PATH)
assert SPEC is not None
check_confidentiality_scan = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(check_confidentiality_scan)


class DotNetConfidentialityScanTests(unittest.TestCase):
    def test_allows_dotnet_httpclient_host_terminology_at_owned_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_dir = root / "dotnet" / "logbrew-dotnet" / "src" / "LogBrew.HttpClient"
            example_dir = source_dir / "examples"
            test_dir = root / "dotnet" / "logbrew-dotnet" / "tests" / "LogBrew.HttpClient.Tests"
            example_dir.mkdir(parents=True)
            test_dir.mkdir(parents=True)
            host_term = "d" + "ns"
            host_name_type = "Host" + "NameType"
            (source_dir / "LogBrewHttpClientFactoryCorrelation.cs").write_text(
                f"requestUri.{host_name_type} != Uri{host_name_type}.{host_term.title()}\n",
                encoding="utf-8",
            )
            (source_dir / "README.md").write_text(
                f"Captured fields include a normalized {host_term.upper()} host.\n",
                encoding="utf-8",
            )
            (example_dir / "HttpClientFactoryCorrelation.cs").write_text(
                f"// Only the normalized {host_term.upper()} host is captured.\n",
                encoding="utf-8",
            )
            (test_dir / "Program.cs").write_text(
                f"using var {host_term}Response = await client.GetAsync(request);\n",
                encoding="utf-8",
            )

            self.assertEqual(check_confidentiality_scan.validate(root), [])

    def test_dotnet_httpclient_host_allowance_rejects_near_misses(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_dir = root / "dotnet" / "logbrew-dotnet" / "src" / "LogBrew.HttpClient"
            source_dir.mkdir(parents=True)
            host_term = "d" + "ns"
            sensitive_term = "cre" + "dential"
            (source_dir / "LogBrewHttpClientFactoryCorrelation.cs").write_text(
                f"The {host_term} value contains a {sensitive_term}.\n",
                encoding="utf-8",
            )
            (source_dir / "OtherHttpClientCorrelation.cs").write_text(
                f"The {host_term} host is captured.\n",
                encoding="utf-8",
            )

            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 2)

    def test_allows_fixed_dotnet_durability_terms_only_at_owned_syntax(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = root / ".github" / "workflows"
            source_dir = root / "dotnet" / "logbrew-dotnet" / "src" / "LogBrew"
            test_dir = root / "dotnet" / "logbrew-dotnet" / "tests" / "LogBrew.Tests"
            workflow_dir.mkdir(parents=True)
            source_dir.mkdir(parents=True)
            test_dir.mkdir(parents=True)
            workflow_word = "stra" + "tegy"
            sensitive_word = "sec" + "ret"
            maintenance_word = "clean" + "up"
            windows_share_read = "WindowsS" + "hareRead"
            windows_share_write = "WindowsS" + "hareWrite"
            windows_share_delete = "WindowsS" + "hareDelete"
            windows_archive_semantics = "WindowsBack" + "upSemantics"
            (workflow_dir / "ci.yml").write_text(
                f"    {workflow_word}:\n",
                encoding="utf-8",
            )
            (root / "dotnet" / "logbrew-dotnet" / "README.md").write_text(
                "Only one process may own a store. Recovery fails closed for missing or wrong keys, "
                "corruption, unknown files, unsafe ownership, links, or replacement. Supply one primary "
                "key and a bounded list of previous keys to rotate records during recovery; new records "
                f"always use the primary key. Key IDs identify keys but are not {sensitive_word} and must contain "
                "only stable letters, numbers, `.`, `_`, or `-`.\n",
                encoding="utf-8",
            )
            (source_dir / "DurableEventStore.cs").write_text(
                f"Clean{maintenance_word[5:]}Acknowledged(recordNames);\n",
                encoding="utf-8",
            )
            (source_dir / "DurableStoreFileSystem.cs").write_text(
                f"private const uint {windows_share_read} = 1;\n"
                f"private const uint {windows_share_write} = 2;\n"
                f"private const uint {windows_share_delete} = 4;\n"
                f"private const uint {windows_archive_semantics} = 0x02000000;\n"
                f"{windows_share_read} | {windows_share_delete},\n"
                f"{windows_share_read} | (allowDelete ? {windows_share_delete} : 0),\n"
                f"{windows_share_read} | {windows_share_write},\n"
                f"{windows_archive_semantics} | WindowsOpenReparsePoint,\n",
                encoding="utf-8",
            )
            (test_dir / "DurableDeliveryContractTests.cs").write_text(
                f"AcknowledgedPrefixClean{maintenance_word[5:]}ResumesAfterExit();\n"
                f'"acknowledged prefix reappeared after {maintenance_word} restart";\n',
                encoding="utf-8",
            )

            self.assertEqual(check_confidentiality_scan.validate(root), [])

    def test_dotnet_durability_allowances_do_not_allow_free_form_terms(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_word = "stra" + "tegy"
            sensitive_word = "sec" + "ret"
            maintenance_word = "clean" + "up"
            visibility_word = "pri" + "vate"
            archive_word = "back" + "up"
            (root / "notes.txt").write_text(
                f"business {workflow_word}\n"
                "cust" + f"omer {sensitive_word}\n"
                f"{maintenance_word} {visibility_word} {archive_word}\n",
                encoding="utf-8",
            )

            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 3)

    def test_dotnet_durability_owned_paths_reject_near_misses(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow_dir = root / ".github" / "workflows"
            source_dir = root / "dotnet" / "logbrew-dotnet" / "src" / "LogBrew"
            test_dir = root / "dotnet" / "logbrew-dotnet" / "tests" / "LogBrew.Tests"
            workflow_dir.mkdir(parents=True)
            source_dir.mkdir(parents=True)
            test_dir.mkdir(parents=True)
            workflow_word = "stra" + "tegy"
            sensitive_word = "sec" + "ret"
            maintenance_word = "clean" + "up"
            archive_word = "back" + "up"
            remote_word = "s" + "sh"
            windows_share_read = "WindowsS" + "hareRead"
            (workflow_dir / "ci.yml").write_text(
                f"    custom-{workflow_word}:\n",
                encoding="utf-8",
            )
            (root / "dotnet" / "logbrew-dotnet" / "README.md").write_text(
                f"The value is {sensitive_word}.\n",
                encoding="utf-8",
            )
            (source_dir / "DurableEventStore.cs").write_text(
                f"var pending{maintenance_word.title()} = true;\n",
                encoding="utf-8",
            )
            (source_dir / "DurableStoreFileSystem.cs").write_text(
                f"private const uint Windows{archive_word.title()}Policy = 1;\n"
                f"private const uint {windows_share_read} = 1; // {remote_word} {archive_word}\n",
                encoding="utf-8",
            )
            (test_dir / "DurableDeliveryContractTests.cs").write_text(
                f'"unexpected {maintenance_word} behavior";\n',
                encoding="utf-8",
            )

            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 6)


if __name__ == "__main__":
    unittest.main()
