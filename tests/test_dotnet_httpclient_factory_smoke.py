import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SMOKE = ROOT / "scripts" / "real_user_dotnet_httpclient_factory_smoke.sh"
PACKAGE_CHECK = ROOT / "scripts" / "check_dotnet_package.sh"


class DotnetHttpClientFactorySmokeTests(unittest.TestCase):
    def test_smoke_binds_exact_local_packages_and_loopback(self) -> None:
        source = SMOKE.read_text()
        for expected in (
            "LogBrew.HttpClient.${httpclient_package_version}.nupkg",
            "package LogBrew.HttpClient --version",
            "NUGET_PACKAGES",
            "sha256",
            "AddLogBrewCorrelation",
            "IHttpClientFactory",
            "TcpListener",
            "ResponseHeadersRead",
            "traceparent",
            "sdkDeliveryRequests",
            "sensitivePath",
            "sensitiveQuery",
        ):
            self.assertIn(expected, source)

    def test_smoke_fails_with_fixed_output(self) -> None:
        source = SMOKE.read_text()
        self.assertIn("installed HttpClient correlation smoke failed", source)
        self.assertNotIn("cat \"$tmp_dir/app.stderr\"", source)
        self.assertNotIn("set -x", source)

    def test_package_gate_owns_the_smoke(self) -> None:
        source = PACKAGE_CHECK.read_text()
        self.assertIn(
            'bash "$repo_root/scripts/real_user_dotnet_httpclient_factory_smoke.sh"',
            source,
        )


if __name__ == "__main__":
    unittest.main()
