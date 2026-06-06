# Trusted Publisher Setup

Use these exact values when creating registry-side trusted publisher records for this repository.

## Shared GitHub Identity

- Repository owner: `LogBrewCo`
- Repository name: `sdk`
- Workflow filename: `publish-packages.yml`
- GitHub environment: `release`

`publish-release.yml` is the release-level dispatcher. Publishing a GitHub Release dispatches
`publish-packages.yml` for that release tag with the configured OIDC-capable registries enabled.
Use its manual `workflow_dispatch` path for a safe dry run or a targeted registry publish.

Run the package workflow in dry-run mode before any real publish:

```bash
gh workflow run publish-packages.yml -R LogBrewCo/sdk -f ref=v0.1.0 -f target=all -f dry_run=true -f include_unity_npm=false -f include_pypi_extras=false -f include_crates_publish=false -f include_go_module=false
```

For `dry_run=false`, `target=all` publishes the OIDC-capable registries only, then verifies the public registry versions it actually published. Run `target=verify` to check already-published public registry versions without uploading anything. Run `target=packagist` explicitly after adding Packagist secrets. Run `target=maven` only after Maven Central signing and release profile work is complete.

## npm

Configure each npm package with GitHub Actions trusted publishing and allowed action `npm publish`.

- `@logbrew/sdk`
- `@logbrew/browser`
- `@logbrew/node`
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

## PyPI

Create GitHub trusted publishers for these PyPI projects:

- `logbrew-sdk`
- `logbrew-fastapi`
- `logbrew-django`

`logbrew-django` was initially created with the temporary `publish-pypi-django.yml` identity to avoid a pending-publisher collision with `logbrew-fastapi`. The project now also trusts the shared `publish-packages.yml` identity, and the main workflow has proven it can publish or skip all three Python packages with `include_pypi_extras=true`. The workflow always builds and checks those distributions, but real publishing only includes them when `include_pypi_extras=true`.

## crates.io

The `logbrew` crate exists and has a crates.io GitHub Actions trusted publisher for `LogBrewCo/sdk`, workflow `publish-packages.yml`, environment `release`. The workflow job uses `rust-lang/crates-io-auth-action@v1` and `cargo publish`.

The workflow always runs `cargo publish --dry-run`; real crates.io upload only runs when `include_crates_publish=true`.

## RubyGems

Create a trusted publisher or pending trusted publisher for gem `logbrew-sdk`. The workflow uses `rubygems/configure-rubygems-credentials@v2.0.0` and then `gem push`.

## NuGet

Create a nuget.org trusted publishing policy with the shared GitHub identity above. Add `NUGET_USER` as a `release` environment secret containing the NuGet username or organization user that owns the package policy.

## Packagist

Packagist does not use GitHub OIDC trusted publishing. Submit `https://github.com/LogBrewCo/sdk` as the VCS repository for `logbrew/sdk`, enable the Packagist GitHub hook, or add `PACKAGIST_USERNAME` and `PACKAGIST_API_TOKEN` as `release` environment secrets so the workflow can trigger the official update-package endpoint after tags move.

## Maven Central

The `co.logbrew` namespace is verified in Maven Central. Keep the public TXT record on `logbrew.co` in place through the first Central release.

Maven Central does not currently offer the same first-party GitHub OIDC trusted publisher flow. The workflow builds a Central Portal deployment bundle with Java and Kotlin jars, source jars, javadoc jars, POMs, and checksums during dry-runs. Real Maven Central upload is only available through explicit `target=maven` runs after adding these `release` environment secrets:

- `CENTRAL_PORTAL_USERNAME`
- `CENTRAL_PORTAL_PASSWORD`
- `MAVEN_GPG_PRIVATE_KEY`
- `MAVEN_GPG_PASSPHRASE`
- `MAVEN_GPG_KEY_ID`

Do not include Maven in automatic release dispatch until a next-version `target=maven` run has proven signing, Central Portal upload, and public Maven metadata verification.

## OpenUPM

OpenUPM is not an OIDC registry. Use `.github/publishing/openupm-co.logbrew.unity.yml` as the package submission metadata for `co.logbrew.unity`.

Current OpenUPM docs support UPM packages in repository subfolders and recommend `gitTagPrefix` for monorepos or duplicate tag families. The package submission PR for `co.logbrew.unity` has merged; keep Unity release tags under the `co.logbrew.unity/` prefix and keep the tag version aligned with `unity/logbrew-unity/package.json`. If OpenUPM indexing cannot process the subfolder package, fall back to a package-root release branch or GitHub Release asset approach whose root contains the contents of `unity/logbrew-unity`.
