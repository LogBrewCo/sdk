# Trusted Publisher Setup

Use these exact values when creating registry-side trusted publisher records for this repository.

## Shared GitHub Identity

- Repository owner: `LogBrewCo`
- Repository name: `sdk`
- Workflow filename: `publish-packages.yml`
- GitHub environment: `release`

Run the workflow in dry-run mode before any real publish:

```bash
gh workflow run publish-packages.yml -R LogBrewCo/sdk -f ref=v0.1.0 -f target=all -f dry_run=true -f include_unity_npm=false
```

For `dry_run=false`, `target=all` publishes the OIDC-capable registries only. Run `target=packagist` explicitly after adding Packagist secrets. Run `target=maven` only after Maven Central signing and release profile work is complete.

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

## crates.io

Create a trusted publisher for crate `logbrew`. The workflow job uses `rust-lang/crates-io-auth-action@v1` and `cargo publish`.

## RubyGems

Create a trusted publisher or pending trusted publisher for gem `logbrew-sdk`. The workflow uses `rubygems/configure-rubygems-credentials@v2.0.0` and then `gem push`.

## NuGet

Create a nuget.org trusted publishing policy with the shared GitHub identity above. Add `NUGET_USER` as a `release` environment secret containing the NuGet username or organization user that owns the package policy.

## Packagist

Packagist does not use GitHub OIDC trusted publishing. Submit `https://github.com/LogBrewCo/sdk` as the VCS repository for `logbrew/sdk`, enable the Packagist GitHub hook, or add `PACKAGIST_USERNAME` and `PACKAGIST_API_TOKEN` as `release` environment secrets so the workflow can trigger the official update-package endpoint after tags move.

## Maven Central

The `co.logbrew` namespace is verified in Maven Central. Keep the public TXT record on `logbrew.co` in place through the first Central release.

Maven Central does not currently offer the same first-party GitHub OIDC trusted publisher flow. The workflow runs Java and Kotlin package preflight on Blacksmith, but real Maven Central deployment remains gated until Central Portal credentials, signing keys, source/javadoc artifacts, and a release profile are added.
