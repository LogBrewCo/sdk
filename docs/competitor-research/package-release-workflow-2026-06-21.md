# Package Release Workflow

## Goal

Tighten LogBrew package release confidence so a real publish verifies the exact package version that was just built, rather than accidentally treating an older public registry version as success.

## Competitor Source Read

- Sentry .NET repo: `getsentry/sentry-dotnet@2f2842f20f9581468a0ab4e971bfd507557161b3`.
- `.github/workflows/release.yml`: the release workflow delegates versioned release preparation to `getsentry/craft`.
- `.github/release.yml`: repo-local Craft release configuration.
- `scripts/bump-version.sh`: Craft convention entrypoint that forwards the new version to PowerShell.
- `scripts/bump-version.ps1`: updates `Directory.Build.props` by replacing `<VersionPrefix>...`.
- `Directory.Build.props`: central package/assembly version source through `<VersionPrefix>6.6.0</VersionPrefix>`.

## Pattern

Sentry keeps version changes centralized and release-tool-owned: the release workflow prepares a concrete version, writes it into the shared .NET build metadata, and then package publishing flows from that versioned state. The tradeoff is a heavier release toolchain, but it reduces ambiguity about which version a NuGet publish represents.

LogBrew already supports repo-wide version gating, but the manual NuGet publish job verified public NuGet through the default registry version. After a changed-package or repo-wide version bump, that could produce weak evidence by finding an older `LogBrew` version instead of proving the version just packed is available.

## LogBrew Change

- `publish-packages.yml` now reads the NuGet package version from `LogBrew.csproj` with `dotnet msbuild -getProperty:Version`.
- The NuGet verification step passes `--nuget-version "LogBrew=<built version>"`.
- `scripts/check_registry_publication.py` now supports NuGet package-version overrides in the same style as npm and PyPI overrides.
- `scripts/check_release_metadata.py` now guards that the workflow keeps exact NuGet version verification wired.

## Verify-Only Follow-Up

The first fix made real NuGet publishes verify the exact built version. A second release-confidence gap remained: manual `target=verify` still checked only default public versions, so maintainers could not recheck a package-specific release without republishing.

`publish-packages.yml` now accepts verify-only inputs:

- `verify_version`
- `verify_npm_versions`
- `verify_pypi_versions`
- `verify_nuget_versions`

The `target=verify` job passes those values to `scripts/check_registry_publication.py`, letting a maintainer recheck examples such as `verify_nuget_versions=LogBrew=0.1.1` after a scoped NuGet publish.

## Changed-Package Readiness Follow-Up

The release workflow now also validates package metadata against the exact NuGet version read from `LogBrew.csproj` before packing, so a package-specific .NET bump does not fail the repo-wide default metadata gate or accidentally validate an older public package.

`LogBrew` is prepared for a `0.1.1` NuGet publish:

- `dotnet/logbrew-dotnet/src/LogBrew/LogBrew.csproj` now declares package version `0.1.1`.
- `Microsoft.Extensions.Logging` is updated from `10.0.1` to `10.0.9`; `dotnet list ... package --outdated` reports no updates.
- `scripts/check_dotnet_package.sh` and `scripts/real_user_dotnet_smoke.sh` derive the packed `.nupkg` version from `LogBrew.csproj` instead of hard-coding `LogBrew.0.1.0.nupkg`.
- The installed-package smoke installs the locally packed `LogBrew=<package version>` in every temporary user app, including install/remove/reinstall proof.

## Verification

- Red tests first:
  - `python3 -m unittest tests/test_registry_publication.py` failed because `--nuget-version` was unsupported and summaries omitted NuGet overrides.
  - `python3 -m unittest tests.test_release_metadata.ReleaseMetadataTests.test_publish_packages_workflow_requires_exact_nuget_version_verification` failed because the release metadata checker did not guard exact NuGet verification.
  - `python3 -m unittest tests.test_release_metadata.ReleaseMetadataTests.test_dotnet_package_accepts_expected_version_override` failed because `validate_dotnet(...)` did not accept a package-specific expected version.
  - `python3 -m unittest tests.test_release_metadata.ReleaseMetadataTests.test_publish_packages_workflow_requires_exact_nuget_metadata_version_validation` failed because the NuGet publish job did not validate metadata against the built package version.
- Green focused proof:
  - `python3 -m unittest tests/test_registry_publication.py tests/test_release_metadata.py`
  - `python3 scripts/check_release_metadata.py`
  - `python3 scripts/check_registry_publication.py --target nuget --nuget-version LogBrew=0.1.0 --retries 1 --retry-delay 1`
- Verify-only follow-up proof:
  - `python3 -m unittest tests.test_release_metadata.ReleaseMetadataTests.test_publish_packages_verify_target_requires_exact_version_inputs`
  - `python3 -m unittest tests/test_registry_publication.py tests/test_release_metadata.py`
- Changed-package readiness proof:
  - `python3 -m unittest tests/test_release_metadata.py`
  - `python3 scripts/check_release_metadata.py`
  - `python3 scripts/check_release_metadata.py --nuget-version LogBrew=0.1.1`
  - `bash scripts/check_dotnet_package.sh`
  - `bash scripts/real_user_dotnet_smoke.sh`
  - `dotnet list dotnet/logbrew-dotnet/src/LogBrew/LogBrew.csproj package --outdated`

## Honest Status

`LogBrew` `0.1.1` is now public on NuGet. GitHub Actions publish run `27906664270` completed the NuGet package job successfully, and independent public registry verification passed with `python3 scripts/check_registry_publication.py --target nuget --nuget-version LogBrew=0.1.1 --retries 20 --retry-delay 30`.

The release was correctly scoped to NuGet; unrelated ecosystems did not need version bumps for this .NET-only release. The next .NET competitor gap is not package availability anymore, but optional automatic ActivitySource/ASP.NET/HttpClient/EF/SqlClient/Redis/Kafka integration packages with richer semantics/events, where Sentry/Datadog/OpenTelemetry remain stronger.

## Activity Span Follow-Up

`LogBrew` `0.1.2` is now public on NuGet for the explicit .NET `Activity` span capture improvement. GitHub Actions CI run `27907943588` passed Contract, Swift, Kotlin, and Objective-C checks for commit `e112c067bc433aaf0136a4ada16516650beebf03`. The scoped NuGet dry run `27908494575` passed package creation without publishing, and real publish run `27908514040` published and verified the public package. Independent registry verification also passed with `python3 scripts/check_registry_publication.py --target nuget --nuget-version LogBrew=0.1.2 --retries 20 --retry-delay 30`.

This keeps the release scoped to the changed .NET package. The remaining .NET market gap is still optional automatic ActivitySource/ASP.NET/HttpClient/EF/SqlClient/Redis/Kafka integration packages with richer semantics/events; the current `0.1.2` release deliberately improves explicit app-owned Activity capture without adding global listeners, exporters, baggage, tracestate, or raw request data capture.
