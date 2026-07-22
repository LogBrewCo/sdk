# GitHub Actions Guide

This repository should start with GitHub-hosted Actions rather than custom runners or local-machine publishing.

## Why this is the better default

- Clean, reproducible builds on every pull request
- Public, reviewable release steps
- Minimal operational overhead
- Protected environments and approval gates when publishing
- Trusted publishing or OIDC support where registries allow it

## Workflow layout

- `ci.yml`: runs on every push to `main` and every pull request
- `release-readiness.yml`: runs manually or on version tags and performs package dry-runs only for ecosystems detected in the repository
- `publish-packages.yml`: manual-only registry publishing with trusted publishing where registries support OIDC, plus public registry version verification after real publishes
- `publish-release.yml`: dispatches package publishing for repo-wide `vMAJOR.MINOR.PATCH` GitHub Releases and intentionally skips package publishing for scoped package tags such as `go/logbrew/v0.1.1`

## GitHub Release tags

Use repo-wide tags such as `v0.1.1` only when the whole SDK repository should run the real `target=all` package publishing path. The repo-wide release workflow checks that every package manifest it would publish already matches the tag version before dispatching registry jobs; if versions are mixed, use scoped/manual changed-package publishing or bump every listed package first.

Use scoped tags containing `/` for package-specific GitHub Release notes, for example `go/logbrew/v0.1.1` or `co.logbrew.unity/v0.1.1`. These releases are informational and do not dispatch registry publishing; publish the relevant package first through `publish-packages.yml`, verify the public registry, then create the scoped GitHub Release so the Releases page reflects package progress without republishing unrelated SDKs.

Important: GitHub evaluates `release` workflows from the release tag's commit, not just from current `main`. Do not create GitHub Releases for historical tags that point to commits before the scoped-release guard unless `publish-release.yml` is disabled or the workflow behavior has been audited first. Prefer creating future scoped release-note tags after the guard is present.

For Maven Central, set `maven_artifacts` to the explicit artifact IDs being released. The workflow validates each selected POM version and exact dependency closure, rejects an immutable-version collision before packaging, records an exact bundle manifest with digests, and installs the selected bundle before upload. Post-publish checks use the same plan so unrelated coordinates are not treated as release evidence.

## Best practices

- Keep default permissions minimal with `contents: read`
- Separate normal CI from release-oriented checks
- Use concurrency to cancel stale CI runs on the same branch
- Run contract tests before ecosystem-specific dry-runs
- Detect manifests and skip irrelevant jobs instead of failing empty repos
- Prefer trusted publishing or OIDC over long-lived registry tokens
- Keep the shared `release` environment restricted to protected branches so registry publishing can run only from protected workflow refs
- Pin explicit hosted toolchain setup for every supported ecosystem instead of relying on whatever `ubuntu-latest` happens to preinstall
- If a real-user smoke script exercises `pnpm` or `yarn`, enable Corepack before the smoke step even when the repo itself does not check in that package manager's lockfile
- Keep local and CI release-readiness checks aligned: if local smoke tests install packaged artifacts, CI should continue to exercise those same artifact-oriented paths
- Prefer verifiers with a machine-readable summary mode so CI and automation can consume pass/fail plus step metadata without scraping logs
- Use Blacksmith runners for publish preflight and OIDC-capable registry jobs where supported, but keep npm's final trusted-publishing job on GitHub-hosted runners because npm does not currently support self-hosted runners for trusted publishing.
- After publishing, verify public registry metadata through `python3 scripts/check_registry_publication.py` or the `publish-packages.yml` `target=verify` mode before treating a release as externally available. Package-specific publishes should verify the exact package version that was just built, for example the NuGet job reads `LogBrew.csproj` and passes that version to the registry verifier. For later standalone verification, dispatch `target=verify` with `verify_version` or package-specific `verify_npm_versions`, `verify_pypi_versions`, `verify_nuget_versions`, `verify_maven_artifacts`, and `verify_maven_versions` overrides.

## What to do next

1. Keep branch protection for `main` requiring the `Contract checks` GitHub Actions check; force pushes and branch deletion should stay disabled.
2. Keep the shared `release` environment deployment policy on protected branches only. `publish-release.yml` dispatches `publish-packages.yml` from the default branch, then `publish-packages.yml` checks out the requested release tag or commit through its `ref` input.
3. Keep `.github/publishing/trusted-publishers.md` aligned with registry-side trusted publisher records.
4. Run publish workflow dry-runs before every external publish.
5. Run `target=verify` after registry publishes or when marketplace state is unclear.
6. Before creating a repo-wide Release, run `python3 scripts/check_repo_wide_release_versions.py vX.Y.Z` and fix any mixed-version output.
