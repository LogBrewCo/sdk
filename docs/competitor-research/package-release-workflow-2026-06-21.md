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

## Verification

- Red tests first:
  - `python3 -m unittest tests/test_registry_publication.py` failed because `--nuget-version` was unsupported and summaries omitted NuGet overrides.
  - `python3 -m unittest tests.test_release_metadata.ReleaseMetadataTests.test_publish_packages_workflow_requires_exact_nuget_version_verification` failed because the release metadata checker did not guard exact NuGet verification.
- Green focused proof:
  - `python3 -m unittest tests/test_registry_publication.py tests/test_release_metadata.py`
  - `python3 scripts/check_release_metadata.py`
  - `python3 scripts/check_registry_publication.py --target nuget --nuget-version LogBrew=0.1.0 --retries 1 --retry-delay 1`

## Honest Status

This improves release evidence, not public package availability. The current public NuGet package remains `LogBrew` `0.1.0`; the recent .NET SDK improvements still need a deliberate changed-package or repo-wide version release before NuGet users can install them from the public registry.
