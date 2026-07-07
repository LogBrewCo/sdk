# Trusted Publisher Setup

Use these exact values when creating registry-side trusted publisher records for this repository.

## Shared GitHub Identity

- Repository owner: `LogBrewCo`
- Repository name: `sdk`
- Workflow filename: `publish-packages.yml`
- GitHub environment: `release`

The shared `release` environment is restricted to protected branches only. Keep that policy in
place before any `dry_run=false` publish because the package workflow uses the environment for
registry access and OIDC identity, while checking out the requested release tag or commit via the
workflow `ref` input.

`publish-release.yml` is the repo-wide release dispatcher. Publishing a GitHub Release with a
`vMAJOR.MINOR.PATCH` tag dispatches `publish-packages.yml` for that release tag with the configured
OIDC-capable registries enabled. Scoped GitHub Releases whose tags contain `/`, such as
`go/logbrew/v0.1.1`, are informational and skip package publishing so the public Releases page can
show package-specific progress without republishing unrelated SDKs. Use the manual
`workflow_dispatch` path for a safe dry run or a targeted registry publish.

Important: GitHub evaluates `release` workflows from the release tag's commit. Do not create
GitHub Releases for historical tags that point to commits before the scoped-release guard unless
`publish-release.yml` is disabled or the workflow behavior has been audited first.
Before creating a repo-wide Release, run `python3 scripts/check_repo_wide_release_versions.py vX.Y.Z`
so mixed package versions fail before registry publishing is dispatched.

Run the package workflow in dry-run mode before any real publish:

```bash
gh workflow run publish-packages.yml -R LogBrewCo/sdk -f ref=v0.1.0 -f target=all -f dry_run=true -f include_unity_npm=false -f include_pypi_extras=false -f include_crates_publish=false -f include_go_module=false
```

For `dry_run=false`, `target=all` publishes the OIDC-capable registries plus Packagist and Maven Central when `include_packagist_update=true` and `include_maven_publish=true`, then verifies the public registry versions it actually published. Repo-wide `vMAJOR.MINOR.PATCH` GitHub Releases enable those flags automatically. Manual dispatch defaults stay dry-run-safe, so use explicit include flags when proving a targeted real publish.

## npm

Configure each npm package with GitHub Actions trusted publishing and allowed action `npm publish`.

- `@logbrew/sdk`
- `@logbrew/browser`
- `@logbrew/node`
- `@logbrew/prisma`
- `@logbrew/bullmq`
- `@logbrew/kafkajs`
- `@logbrew/amqplib`
- `@logbrew/aws-sqs`
- `@logbrew/express`
- `@logbrew/fastify`
- `@logbrew/nestjs`
- `@logbrew/angular`
- `@logbrew/vue`
- `@logbrew/svelte`
- `@logbrew/react`
- `@logbrew/react-native`
- `@logbrew/next`
- `co.logbrew.unity` if Unity is intentionally published to npm as a UPM-compatible package

Important: npm currently supports trusted publishing only on GitHub-hosted runners, GitLab.com shared runners, or CircleCI cloud. The `npm` job intentionally uses `ubuntu-latest`; the other publish jobs use Blacksmith where compatible.

For a changed JS integration release, manual `target=npm` dispatch can restrict publishing and verification to selected npm packages with `npm_packages`. Use package names or package directories, separated by commas. Leave `npm_packages` empty for the existing all-npm package behavior.

```bash
gh workflow run publish-packages.yml -R LogBrewCo/sdk -f ref=v0.1.1 -f target=npm -f dry_run=true -f include_unity_npm=false -f npm_packages=@logbrew/nestjs
```

Brand-new npm package names need a package page before repeat trusted-publisher
updates can work. npm's `npm trust` command requires the package to already
exist, so the first public publish for a new name must use an authenticated
package-creation path. Prefer a one-time `target=npm` run with
`allow_initial_npm_publish=true` only after adding a narrowly scoped `NPM_TOKEN`
to the `release` environment, then configure the package's trusted publisher and
return `allow_initial_npm_publish` to `false` for future OIDC publishes. The
workflow rejects `dry_run=false` when a selected package page is missing and
this explicit first-publish path is not enabled.

## PyPI

Create GitHub trusted publishers for these PyPI projects:

- `logbrew-sdk`
- `logbrew-fastapi`
- `logbrew-flask`
- `logbrew-django`

`logbrew-django` was initially created with a temporary one-off workflow identity to avoid a pending-publisher collision with `logbrew-fastapi`. The project now trusts the shared `publish-packages.yml` identity, and the temporary workflow has been removed so repeat updates use one audited PyPI path. The workflow always builds and checks all four distributions, but real publishing only includes the FastAPI, Flask, and Django packages when `include_pypi_extras=true`.

## crates.io

The `logbrew` crate exists and has a crates.io GitHub Actions trusted publisher for `LogBrewCo/sdk`, workflow `publish-packages.yml`, environment `release`. The workflow job uses `rust-lang/crates-io-auth-action@v1` and `cargo publish`.

The workflow always runs `cargo publish --dry-run`; real crates.io upload only runs when `include_crates_publish=true`.

## RubyGems

Create a trusted publisher or pending trusted publisher for gem `logbrew-sdk`. The workflow uses `rubygems/configure-rubygems-credentials@v2.0.0` and then `gem push`.

## NuGet

Create a nuget.org trusted publishing policy with the shared GitHub identity above. Add `NUGET_USER` as a `release` environment secret containing the NuGet username or organization user that owns the package policy.

The NuGet job reads the package version from `dotnet/logbrew-dotnet/src/LogBrew/LogBrew.csproj` before packing and verifies that exact `LogBrew=<version>` is public after a real publish. Do not treat a NuGet release as available based only on the default repo-wide public version check.

For a later verification-only run, dispatch `publish-packages.yml` with `target=verify` and `verify_nuget_versions=LogBrew=<version>` so the workflow rechecks the exact package-specific version without republishing.

## Packagist

Packagist does not use GitHub OIDC trusted publishing. The public `logbrew/sdk` package is auto-updated from `https://github.com/LogBrewCo/sdk`, so the workflow validates Composer metadata and then verifies Packagist's public version after tags move. `PACKAGIST_USERNAME` and `PACKAGIST_API_TOKEN` are optional `release` environment secrets for triggering the official update-package endpoint sooner; when they are absent, the workflow relies on Packagist auto-update instead of skipping the registry.

## Maven Central

The `co.logbrew` namespace is verified in Maven Central. Keep the public TXT record on `logbrew.co` in place through the first Central release.

For a later verification-only run before every optional Maven artifact is public, dispatch `publish-packages.yml` with `target=verify`, `verify_maven_artifacts=logbrew-sdk,logbrew-kotlin`, and matching `verify_maven_versions=co.logbrew:logbrew-sdk=<version>,co.logbrew:logbrew-kotlin=<version>` so the workflow rechecks only the artifacts that are actually available.

Maven Central does not currently offer the same first-party GitHub OIDC trusted publisher flow. The workflow builds a Central Portal deployment bundle with Java and Kotlin jars, source jars, javadoc jars, POMs, and checksums during dry-runs. Real Maven Central upload runs from published GitHub Releases after adding these `release` environment secrets:

- `CENTRAL_PORTAL_USERNAME`
- `CENTRAL_PORTAL_PASSWORD`
- `MAVEN_GPG_PRIVATE_KEY`
- `MAVEN_GPG_KEY_ID`
- `MAVEN_GPG_PASSPHRASE` only when the signing key requires one

`CENTRAL_PORTAL_USERNAME` and `CENTRAL_PORTAL_PASSWORD` must be generated Central Portal publishing values with `co.logbrew` namespace publish access, not Central account-login values. A masked-env upload failure with HTTP 401 means those values or namespace permission must be corrected before rerunning the Maven publish workflow; do not rerun source/package checks to solve that state.

Published GitHub Releases pass `include_maven_publish=true`, so Maven Central participates in `target=all` once the release settings above exist. A next-version release is still the first real proof of Central Portal upload and public Maven metadata verification because Maven Central will not accept re-uploading the existing `0.1.0` artifacts.

## OpenUPM

OpenUPM is not an OIDC registry. Use `.github/publishing/openupm-co.logbrew.unity.yml` as the package submission metadata for `co.logbrew.unity`.

Current OpenUPM docs support UPM packages in repository subfolders and recommend `gitTagPrefix` for monorepos or duplicate tag families. The package submission PR for `co.logbrew.unity` has merged; keep Unity release tags under the `co.logbrew.unity/` prefix and keep the tag version aligned with `unity/logbrew-unity/package.json`. If OpenUPM indexing cannot process the subfolder package, fall back to a package-root release branch or GitHub Release asset approach whose root contains the contents of `unity/logbrew-unity`.
