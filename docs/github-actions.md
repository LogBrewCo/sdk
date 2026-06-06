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

## Best practices

- Keep default permissions minimal with `contents: read`
- Separate normal CI from release-oriented checks
- Use concurrency to cancel stale CI runs on the same branch
- Run contract tests before ecosystem-specific dry-runs
- Detect manifests and skip irrelevant jobs instead of failing empty repos
- Prefer trusted publishing or OIDC over long-lived registry tokens
- Add protected environments before any real publish job is enabled
- Pin explicit hosted toolchain setup for every supported ecosystem instead of relying on whatever `ubuntu-latest` happens to preinstall
- If a real-user smoke script exercises `pnpm` or `yarn`, enable Corepack before the smoke step even when the repo itself does not check in that package manager's lockfile
- Keep local and CI release-readiness checks aligned: if local smoke tests install packaged artifacts, CI should continue to exercise those same artifact-oriented paths
- Prefer verifiers with a machine-readable summary mode so CI and automation can consume pass/fail plus step metadata without scraping logs
- Use Blacksmith runners for publish preflight and OIDC-capable registry jobs where supported, but keep npm's final trusted-publishing job on GitHub-hosted runners because npm does not currently support self-hosted runners for trusted publishing.
- After publishing, verify public registry metadata through `python3 scripts/check_registry_publication.py` or the `publish-packages.yml` `target=verify` mode before treating a release as externally available.

## What to do next

1. Enable branch protection for `main` and require the `CI / Contract checks` job.
2. Add protected GitHub environments for each registry publish target before running `publish-packages.yml` with `dry_run=false`.
3. Keep `.github/publishing/trusted-publishers.md` aligned with registry-side trusted publisher records.
4. Run publish workflow dry-runs before every external publish.
5. Run `target=verify` after registry publishes or when marketplace state is unclear.
