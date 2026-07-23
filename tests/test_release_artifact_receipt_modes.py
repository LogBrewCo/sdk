from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ReleaseArtifactReceiptModeTests(unittest.TestCase):
    def test_changed_family_smokes_bind_install_and_attest_exact_artifacts(self) -> None:
        scripts = {
            "crates": "real_user_cratesio_public_smoke.sh",
            "go": "real_user_go_public_module_smoke.sh",
            "maven": "real_user_maven_central_public_smoke.sh",
            "nuget": "real_user_dotnet_selected_public_nuget_smoke.sh",
            "packagist": "real_user_packagist_public_smoke.sh",
            "pypi": "real_user_python_public_pypi_smoke.sh",
            "rubygems": "real_user_rubygems_public_smoke.sh",
            "swiftpm": "real_user_swiftpm_public_smoke.sh",
        }
        for family, script_name in scripts.items():
            with self.subTest(family=family):
                body = (ROOT / "scripts" / script_name).read_text(encoding="utf-8")
                self.assertIn('LOGBREW_RELEASE_RECEIPT_MODE', body)
                self.assertIn('release_artifact_receipt.py" bind', body)
                self.assertIn(f'--family "{family}"', body)
                self.assertIn('release_artifact_receipt.py" attest', body)
                self.assertIn('run_receipt_smoke', body)

    def test_normal_registry_mode_remains_the_default(self) -> None:
        for script_name in (
            "real_user_cratesio_public_smoke.sh",
            "real_user_go_public_module_smoke.sh",
            "real_user_maven_central_public_smoke.sh",
            "real_user_dotnet_selected_public_nuget_smoke.sh",
            "real_user_packagist_public_smoke.sh",
            "real_user_python_public_pypi_smoke.sh",
            "real_user_rubygems_public_smoke.sh",
            "real_user_swiftpm_public_smoke.sh",
        ):
            with self.subTest(script=script_name):
                body = (ROOT / "scripts" / script_name).read_text(encoding="utf-8")
                self.assertIn('receipt_mode="${LOGBREW_RELEASE_RECEIPT_MODE:-0}"', body)

    def test_nuget_receipt_installs_the_bound_packages_from_canonical_hard_links(self) -> None:
        body = (
            ROOT / "scripts" / "real_user_dotnet_selected_public_nuget_smoke.sh"
        ).read_text(encoding="utf-8")

        self.assertIn(
            'ln "$bound/0.nupkg" "$source_dir/LogBrew.${core_version}.nupkg"',
            body,
        )
        self.assertIn('ln "$bound/1.nupkg"', body)
        self.assertIn(
            '"$source_dir/LogBrew.HttpClient.${httpclient_version}.nupkg"', body
        )
        self.assertIn('<add key="receipt" value="$source_dir" />', body)
        self.assertNotIn('<add key="receipt" value="$bound" />', body)


if __name__ == "__main__":
    unittest.main()
